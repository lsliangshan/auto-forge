import {
  ipcChannels,
  ipcRequestSchemas,
  ipcResponseSchemas,
  toSafeAppError,
  type AppError,
  type DesktopAPI,
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
  chat: Omit<DesktopAPI['chat'], 'onEvent'>
  workflows: DesktopAPI['workflows']
  developer: DesktopAPI['developer']
  executions: Omit<DesktopAPI['executions'], 'onEvent'>
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
  const register = <Channel extends RequestChannel>(
    channel: Channel,
    operation: (input: z.infer<(typeof ipcRequestSchemas)[Channel]>) => unknown | Promise<unknown>,
  ) => {
    options.ipcMain.handle(channel, (event, input) => invokeValidated(
      channel,
      event,
      input,
      options,
      operation as (value: never) => unknown | Promise<unknown>,
    ))
    registered.push(channel)
  }

  register(ipcChannels.chatListConversations, () => options.services.chat.listConversations())
  register(ipcChannels.chatListMessages, (input) => options.services.chat.listMessages(input.conversationId))
  register(ipcChannels.chatCreateConversation, () => options.services.chat.createConversation())
  register(ipcChannels.chatRenameConversation, (input) => options.services.chat.renameConversation(input.conversationId, input.title))
  register(ipcChannels.chatDeleteConversation, (input) => options.services.chat.deleteConversation(input.conversationId))
  register(ipcChannels.chatSend, (input) => options.services.chat.send(input))
  register(ipcChannels.chatCancel, (input) => options.services.chat.cancel(input.requestId))
  register(ipcChannels.workflowsList, (input) => options.services.workflows.list(input))
  register(ipcChannels.workflowsGet, (input) => options.services.workflows.get(input.id, input.version))
  register(ipcChannels.workflowsSetEnabled, (input) => options.services.workflows.setEnabled(input.id, input.enabled))
  register(ipcChannels.workflowsRemove, (input) => options.services.workflows.remove(input.id, input.version))
  register(ipcChannels.workflowsInstallProject, (input) => options.services.workflows.installProject(input.projectId))
  register(ipcChannels.developerCreateProject, (input) => options.services.developer.createProject(input.name))
  register(ipcChannels.developerRegisterProject, () => options.services.developer.registerProject())
  register(ipcChannels.developerReadFile, (input) => options.services.developer.readFile(input.projectId, input.relativePath))
  register(ipcChannels.developerWriteFile, (input) => options.services.developer.writeFile(input.projectId, input.relativePath, input.content))
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
  register(ipcChannels.settingsSaveOpenRouterKey, (input) => options.services.settings.saveOpenRouterKey(input.apiKey))
  register(ipcChannels.settingsClearOpenRouterKey, () => options.services.settings.clearOpenRouterKey())
  register(ipcChannels.settingsValidateOpenRouterKey, () => options.services.settings.validateOpenRouterKey())
  register(ipcChannels.settingsListModels, () => options.services.settings.listModels())
  register(ipcChannels.settingsClearLocalData, (input) => options.services.settings.clearLocalData(input.scope))
  register(ipcChannels.systemOpenExternal, (input) => options.services.system.openExternal(input.url))

  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const channel of registered) options.ipcMain.removeHandler(channel)
    if (registrations.get(options.ipcMain) === dispose) registrations.delete(options.ipcMain)
  }
  registrations.set(options.ipcMain, dispose)
  return dispose
}
