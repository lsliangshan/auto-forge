import {
  ipcChannels,
  ipcRequestSchemas,
  ipcResponseSchemas,
  toSafeAppError,
  type AppError,
  type AuthSession,
  type DesktopAPI,
  type KnowledgeBase,
  type KnowledgeCitationPreview,
  type KnowledgeCitationPreviewRequest,
  type KnowledgeConsentState,
  type KnowledgeDocument,
  type KnowledgeEntitlementState,
  type KnowledgeFeatureAvailability,
  type KnowledgeSearchOutcome,
  type KnowledgeSelection,
  type KnowledgeVersion,
  type MediaAsset,
  type MediaImportContext,
  type MediaRemoveDraftRequest,
} from '@autoforge/shared'
import type { z } from 'zod'
import type { KnowledgeOwner } from '../knowledge/knowledge-types.js'
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
  knowledgeAdmission: {
    run<T>(operation: () => Promise<T>): Promise<T>
  }
  previewKnowledgeCitation(
    owner: KnowledgeOwner,
    input: KnowledgeCitationPreviewRequest,
  ): Promise<KnowledgeCitationPreview>
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
  permissions: DesktopAPI['permissions']
  settings: DesktopAPI['settings']
  knowledge: {
    listBases(owner: KnowledgeOwner): Promise<KnowledgeBase[]>
    createBase(owner: KnowledgeOwner, name: string): Promise<KnowledgeBase>
    listDocuments(owner: KnowledgeOwner, knowledgeBaseId: string): Promise<KnowledgeDocument[]>
    listVersions(owner: KnowledgeOwner, documentId: string): Promise<KnowledgeVersion[]>
    importDocument(owner: KnowledgeOwner, knowledgeBaseId: string): Promise<KnowledgeDocument | undefined>
    replaceDocument(owner: KnowledgeOwner, documentId: string): Promise<KnowledgeDocument | undefined>
    recycleDocument(owner: KnowledgeOwner, documentId: string): Promise<void>
    purgeDocument(owner: KnowledgeOwner, documentId: string): Promise<void>
    recycleBase(owner: KnowledgeOwner, knowledgeBaseId: string): Promise<void>
    purgeBase(owner: KnowledgeOwner, knowledgeBaseId: string): Promise<void>
    exportBase(owner: KnowledgeOwner, knowledgeBaseId: string): Promise<void>
    getConversationSelection(owner: KnowledgeOwner, conversationId: string): Promise<KnowledgeSelection>
    updateConversationSelection(owner: KnowledgeOwner, conversationId: string, selection: KnowledgeSelection): Promise<KnowledgeSelection>
    search(owner: KnowledgeOwner, conversationId: string, query: string): Promise<KnowledgeSearchOutcome>
    getFeatureAvailability(owner: KnowledgeOwner): Promise<KnowledgeFeatureAvailability>
    getEntitlement(owner: KnowledgeOwner): Promise<KnowledgeEntitlementState>
    getConsent(owner: KnowledgeOwner): Promise<KnowledgeConsentState>
    setEmbeddingConsent(
      owner: KnowledgeOwner,
      status: 'granted' | 'denied' | 'revoked',
    ): Promise<KnowledgeConsentState>
    chooseDowngradeSelection(
      owner: KnowledgeOwner,
      selection: { knowledgeBaseId: string; documentId: string },
    ): Promise<KnowledgeEntitlementState>
  }
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
  const registerKnowledge = <Channel extends RequestChannel>(
    channel: Channel,
    operation: (
      owner: KnowledgeOwner,
      input: z.infer<(typeof ipcRequestSchemas)[Channel]>,
    ) => unknown | Promise<unknown>,
  ) => {
    register(channel, input => options.services.knowledgeAdmission.run(async () => {
      const session = await options.services.auth.requireSession()
      return operation({ userId: session.user.id }, input)
    }), { anonymous: true })
  }

  register(ipcChannels.authGetSession, () => options.services.auth.getSession(), { anonymous: true })
  register(ipcChannels.authRefreshAuthorization, () => options.services.auth.refreshAuthorization())
  register(ipcChannels.authSendOtp, (input) => options.services.auth.sendOtp(input), { anonymous: true })
  register(ipcChannels.authVerifyOtp, (input) => options.services.auth.verifyOtp(input), { anonymous: true })
  register(ipcChannels.authCancelOtp, (input) => options.services.auth.cancelOtp(input.challengeId), { anonymous: true })
  register(ipcChannels.authLoginWithPassword, (input) => options.services.auth.loginWithPassword(input), { anonymous: true })
  register(ipcChannels.authLogout, () => options.services.auth.logout(), { anonymous: true })
  register(ipcChannels.userAdminList, (input) => options.services.userAdmin.list(input))
  register(ipcChannels.userAdminUpdateRole, (input) => options.services.userAdmin.updateRole(input))
  register(ipcChannels.profileGet, () => options.services.profile.get())
  register(ipcChannels.profileUpdate, (input) => options.services.profile.update(input))
  register(ipcChannels.profilePickAndUploadAvatar, () => options.services.profile.pickAndUploadAvatar())
  register(ipcChannels.chatListConversations, () => options.services.chat.listConversations())
  register(ipcChannels.chatListMessages, (input) => options.services.chat.listMessages(input.conversationId))
  register(ipcChannels.chatCreateConversation, () => options.services.chat.createConversation())
  register(ipcChannels.chatRenameConversation, (input) => options.services.chat.renameConversation(input.conversationId, input.title))
  register(ipcChannels.chatDeleteConversation, (input) => options.services.chat.deleteConversation(input.conversationId))
  register(ipcChannels.chatSend, (input) => options.services.chat.send(input))
  register(ipcChannels.chatCancel, (input) => options.services.chat.cancel(input.requestId))
  register(ipcChannels.chatDecideKnowledgeConsent, (input) => (
    options.services.chat.decideKnowledgeConsent(input)
  ))
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
  register(ipcChannels.permissionsListGrants, () => options.services.permissions.listGrants())
  register(ipcChannels.permissionsRevoke, (input) => options.services.permissions.revoke(input.grantId))
  register(ipcChannels.settingsGet, () => options.services.settings.get())
  register(ipcChannels.settingsUpdate, (input) => options.services.settings.update(input))
  register(ipcChannels.settingsSaveProviderApiKey, (input) => options.services.settings.saveProviderApiKey(input.provider, input.apiKey))
  register(ipcChannels.settingsClearProviderApiKey, (input) => options.services.settings.clearProviderApiKey(input.provider))
  register(ipcChannels.settingsValidateProviderCredential, (input) => options.services.settings.validateProviderCredential(input.provider))
  register(ipcChannels.settingsListProviderModels, (input) => options.services.settings.listProviderModels(input.provider, input.refresh))
  register(ipcChannels.settingsGetTokenUsage, () => options.services.settings.getTokenUsage())
  register(ipcChannels.settingsClearLocalData, (input) => options.services.settings.clearLocalData(input.scope))
  register(ipcChannels.settingsClearBrowserData, () => options.services.settings.clearBrowserData())
  registerKnowledge(ipcChannels.knowledgeListBases, (owner) => options.services.knowledge.listBases(owner))
  registerKnowledge(ipcChannels.knowledgeCreateBase, (owner, input) => options.services.knowledge.createBase(owner, input.name))
  registerKnowledge(ipcChannels.knowledgeListDocuments, (owner, input) => options.services.knowledge.listDocuments(owner, input.knowledgeBaseId))
  registerKnowledge(ipcChannels.knowledgeListVersions, (owner, input) => options.services.knowledge.listVersions(owner, input.documentId))
  registerKnowledge(ipcChannels.knowledgeImportDocument, (owner, input) => options.services.knowledge.importDocument(owner, input.knowledgeBaseId))
  registerKnowledge(ipcChannels.knowledgeReplaceDocument, (owner, input) => options.services.knowledge.replaceDocument(owner, input.documentId))
  registerKnowledge(ipcChannels.knowledgeRecycleDocument, (owner, input) => options.services.knowledge.recycleDocument(owner, input.documentId))
  registerKnowledge(ipcChannels.knowledgePurgeDocument, (owner, input) => options.services.knowledge.purgeDocument(owner, input.documentId))
  registerKnowledge(ipcChannels.knowledgeRecycleBase, (owner, input) => options.services.knowledge.recycleBase(owner, input.knowledgeBaseId))
  registerKnowledge(ipcChannels.knowledgePurgeBase, (owner, input) => options.services.knowledge.purgeBase(owner, input.knowledgeBaseId))
  registerKnowledge(ipcChannels.knowledgeExportBase, (owner, input) => options.services.knowledge.exportBase(owner, input.knowledgeBaseId))
  registerKnowledge(ipcChannels.knowledgeGetConversationSelection, (owner, input) => options.services.knowledge.getConversationSelection(owner, input.conversationId))
  registerKnowledge(ipcChannels.knowledgeUpdateConversationSelection, (owner, input) => options.services.knowledge.updateConversationSelection(
    owner,
    input.conversationId,
    input.selection,
  ))
  registerKnowledge(ipcChannels.knowledgeSearch, (owner, input) => options.services.knowledge.search(
    owner,
    input.conversationId,
    input.query,
  ))
  registerKnowledge(ipcChannels.knowledgePreviewCitation, (owner, input) => (
    options.services.previewKnowledgeCitation(owner, input)
  ))
  registerKnowledge(ipcChannels.knowledgeGetFeatureAvailability, (owner) => options.services.knowledge.getFeatureAvailability(owner))
  registerKnowledge(ipcChannels.knowledgeGetEntitlement, (owner) => options.services.knowledge.getEntitlement(owner))
  registerKnowledge(ipcChannels.knowledgeGetConsent, (owner) => options.services.knowledge.getConsent(owner))
  registerKnowledge(ipcChannels.knowledgeSetEmbeddingConsent, (owner, input) => (
    options.services.knowledge.setEmbeddingConsent(owner, input.status)
  ))
  registerKnowledge(ipcChannels.knowledgeChooseDowngradeSelection, (owner, input) => (
    options.services.knowledge.chooseDowngradeSelection(owner, input)
  ))
  register(ipcChannels.systemOpenExternal, (input) => options.services.system.openExternal(input.url))
  register(ipcChannels.systemGetAppInfo, () => options.services.system.getAppInfo())

  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const channel of registered) options.ipcMain.removeHandler(channel)
    if (registrations.get(options.ipcMain) === dispose) registrations.delete(options.ipcMain)
  }
  registrations.set(options.ipcMain, dispose)
  return dispose
}
