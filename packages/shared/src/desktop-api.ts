import { z } from 'zod'
import { chatBlockSchema, type ChatBlock, type ChatEvent, type ExecutionEvent, type ExecutionStatus } from './events.js'
import {
  capabilitySchema,
  capabilityScopeSchema,
  type Capability,
  type CapabilityScope,
} from './worker-protocol.js'

const identifierSchema = z.string().trim().min(1)
const timestampSchema = z.string().datetime()
const nonEmptyStringSchema = z.string().trim().min(1)

export const conversationSummarySchema = z.object({
  id: identifierSchema,
  title: nonEmptyStringSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict()

export type ConversationSummary = z.infer<typeof conversationSummarySchema>

export const chatMessageSchema = z.object({
  id: identifierSchema,
  conversationId: identifierSchema,
  role: z.enum(['user', 'assistant']),
  blocks: z.array(chatBlockSchema),
  executionId: identifierSchema.optional(),
  createdAt: timestampSchema,
}).strict()

export interface ChatMessage extends Omit<z.infer<typeof chatMessageSchema>, 'blocks'> { blocks: ChatBlock[] }

export const chatSendInputSchema = z.object({
  conversationId: identifierSchema,
  content: nonEmptyStringSchema,
  model: nonEmptyStringSchema.optional(),
}).strict()

export type ChatSendInput = z.infer<typeof chatSendInputSchema>

export const workflowQuerySchema = z.object({
  search: z.string().trim().optional(),
  category: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  source: z.enum(['installed', 'development']).optional(),
}).strict()

export type WorkflowQuery = z.infer<typeof workflowQuerySchema>

export const workflowPermissionSchema = z.object({
  capability: capabilitySchema,
  scope: capabilityScopeSchema,
}).strict().superRefine(({ capability, scope }, context) => {
  const needsOrigins = capability.startsWith('browser.') || capability === 'network.fetch'
  const needsPaths = capability.startsWith('filesystem.')

  if (needsOrigins && !('origins' in scope)) {
    context.addIssue({ code: 'custom', message: 'This capability requires origin scope' })
  }
  if (needsPaths && !('paths' in scope)) {
    context.addIssue({ code: 'custom', message: 'This capability requires path scope' })
  }
  if (!needsOrigins && !needsPaths && Object.keys(scope).length !== 0) {
    context.addIssue({ code: 'custom', message: 'This capability requires an empty scope' })
  }
})

export interface WorkflowPermission {
  capability: Capability
  scope: CapabilityScope
}

export const workflowSummarySchema = z.object({
  id: identifierSchema,
  version: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  description: z.string(),
  author: nonEmptyStringSchema,
  category: nonEmptyStringSchema,
  enabled: z.boolean(),
  source: z.enum(['installed', 'development']),
  integrity: z.enum(['valid', 'failed', 'unchecked']),
  updatedAt: timestampSchema,
}).strict()

export type WorkflowSummary = z.infer<typeof workflowSummarySchema>

export const workflowDetailSchema = workflowSummarySchema.extend({
  codeSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  permissions: z.array(workflowPermissionSchema),
  activationExamples: z.array(nonEmptyStringSchema),
  activationNegativeExamples: z.array(nonEmptyStringSchema),
  timeoutMs: z.number().int().min(1_000).max(300_000),
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
})

export type WorkflowDetail = z.infer<typeof workflowDetailSchema>

export const validationDiagnosticSchema = z.object({
  path: z.string(),
  message: nonEmptyStringSchema,
  severity: z.enum(['error', 'warning']),
}).strict()

export type ValidationDiagnostic = z.infer<typeof validationDiagnosticSchema>

export const validationResultSchema = z.object({
  valid: z.boolean(),
  diagnostics: z.array(validationDiagnosticSchema),
}).strict()

export type ValidationResult = z.infer<typeof validationResultSchema>

export const developerProjectSchema = z.object({
  id: identifierSchema,
  name: nonEmptyStringSchema,
  rootPath: nonEmptyStringSchema,
  status: z.enum(['new', 'building', 'ready', 'invalid', 'error']),
  files: z.array(nonEmptyStringSchema),
  updatedAt: timestampSchema,
}).strict()

export type DeveloperProject = z.infer<typeof developerProjectSchema>

export const developerRunInputSchema = z.object({
  projectId: identifierSchema,
  input: z.unknown(),
}).strict()

export type DeveloperRunInput = z.infer<typeof developerRunInputSchema>

export const executionQuerySchema = z.object({
  status: z.enum([
    'queued', 'awaiting_approval', 'running', 'completed', 'failed', 'cancelled', 'interrupted',
  ]).optional(),
  workflowId: identifierSchema.optional(),
  search: z.string().trim().optional(),
  from: timestampSchema.optional(),
  to: timestampSchema.optional(),
}).strict()

export type ExecutionQuery = z.infer<typeof executionQuerySchema>

export const executionSummarySchema = z.object({
  id: identifierSchema,
  workflowId: identifierSchema,
  workflowVersion: nonEmptyStringSchema,
  status: z.enum([
    'queued', 'awaiting_approval', 'running', 'completed', 'failed', 'cancelled', 'interrupted',
  ]),
  startedAt: timestampSchema.optional(),
  finishedAt: timestampSchema.optional(),
  createdAt: timestampSchema,
}).strict()

export interface ExecutionSummary extends Omit<z.infer<typeof executionSummarySchema>, 'status'> {
  status: ExecutionStatus
}

export const executionStepSchema = z.object({
  id: identifierSchema,
  label: nonEmptyStringSchema,
  status: z.enum(['running', 'completed', 'failed']),
  startedAt: timestampSchema.optional(),
  finishedAt: timestampSchema.optional(),
}).strict()

export type ExecutionStep = z.infer<typeof executionStepSchema>

export const executionLogSchema = z.object({
  id: identifierSchema,
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
  createdAt: timestampSchema,
}).strict()

export type ExecutionLog = z.infer<typeof executionLogSchema>

export const executionDetailSchema = executionSummarySchema.extend({
  input: z.unknown(),
  output: z.unknown().optional(),
  error: z.object({
    code: nonEmptyStringSchema,
    message: nonEmptyStringSchema,
  }).strict().optional(),
  steps: z.array(executionStepSchema),
  logs: z.array(executionLogSchema),
})

export interface ExecutionDetail extends Omit<z.infer<typeof executionDetailSchema>, 'status'> {
  status: ExecutionStatus
}

const oneTimeApprovalDecisionSchema = z.object({
  executionId: identifierSchema,
  permissionIndex: z.number().int().nonnegative(),
  scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['once', 'deny']),
}).strict()

const persistentApprovalDecisionSchema = z.object({
  executionId: identifierSchema,
  permissionIndex: z.number().int().nonnegative(),
  scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.literal('always'),
  workflowId: identifierSchema,
  workflowVersion: nonEmptyStringSchema,
  capability: capabilitySchema,
  scope: capabilityScopeSchema,
}).strict().superRefine(({ capability, scope }, context) => {
  const result = workflowPermissionSchema.safeParse({ capability, scope })
  if (!result.success) {
    context.addIssue({ code: 'custom', message: 'Persistent approval scope is invalid for this capability' })
  }
})

export const approvalDecisionSchema = z.union([
  oneTimeApprovalDecisionSchema,
  persistentApprovalDecisionSchema,
])

export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>

export const permissionGrantSchema = z.object({
  id: identifierSchema,
  workflowId: identifierSchema,
  workflowVersion: nonEmptyStringSchema,
  capability: capabilitySchema,
  scope: capabilityScopeSchema,
  createdAt: timestampSchema,
}).strict()

export type PermissionGrant = z.infer<typeof permissionGrantSchema>

export const appSettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']),
  language: z.enum(['zh-CN', 'en-US']),
  dataDirectory: nonEmptyStringSchema,
  logDirectory: nonEmptyStringSchema,
  defaultModel: z.string(),
  showCosts: z.boolean(),
  developerMode: z.boolean(),
  permissionDefault: z.literal('ask'),
}).strict()

export type AppSettings = z.infer<typeof appSettingsSchema>

export const appSettingsPatchSchema = appSettingsSchema.partial().strict()

export type AppSettingsPatch = z.infer<typeof appSettingsPatchSchema>

export const credentialStatusSchema = z.object({
  configured: z.boolean(),
  valid: z.boolean(),
  message: z.string().optional(),
  checkedAt: timestampSchema.optional(),
}).strict()

export type CredentialStatus = z.infer<typeof credentialStatusSchema>

export const modelInfoSchema = z.object({
  id: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  contextLength: z.number().int().positive().optional(),
  inputCostPerMillion: z.number().nonnegative().optional(),
  outputCostPerMillion: z.number().nonnegative().optional(),
}).strict()

export type ModelInfo = z.infer<typeof modelInfoSchema>

export const appInfoSchema = z.object({
  version: nonEmptyStringSchema,
  platform: z.enum(['darwin', 'win32']),
}).strict()
export type AppInfo = z.infer<typeof appInfoSchema>

export const ipcChannels = {
  chatListConversations: 'chat:list-conversations',
  chatListMessages: 'chat:list-messages',
  chatCreateConversation: 'chat:create-conversation',
  chatRenameConversation: 'chat:rename-conversation',
  chatDeleteConversation: 'chat:delete-conversation',
  chatSend: 'chat:send',
  chatCancel: 'chat:cancel',
  chatEvent: 'chat:event',
  workflowsList: 'workflows:list',
  workflowsGet: 'workflows:get',
  workflowsSetEnabled: 'workflows:set-enabled',
  workflowsRemove: 'workflows:remove',
  workflowsInstallProject: 'workflows:install-project',
  developerCreateProject: 'developer:create-project',
  developerRegisterProject: 'developer:register-project',
  developerReadFile: 'developer:read-file',
  developerWriteFile: 'developer:write-file',
  developerBuildProject: 'developer:build-project',
  developerValidate: 'developer:validate',
  developerRun: 'developer:run',
  executionsList: 'executions:list',
  executionsGet: 'executions:get',
  executionsDecide: 'executions:decide',
  executionsCancel: 'executions:cancel',
  executionsEvent: 'executions:event',
  permissionsListGrants: 'permissions:list-grants',
  permissionsRevoke: 'permissions:revoke',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsSaveOpenRouterKey: 'settings:save-openrouter-key',
  settingsClearOpenRouterKey: 'settings:clear-openrouter-key',
  settingsValidateOpenRouterKey: 'settings:validate-openrouter-key',
  settingsListModels: 'settings:list-models',
  settingsClearLocalData: 'settings:clear-local-data',
  systemOpenExternal: 'system:open-external',
  systemGetAppInfo: 'system:get-app-info',
} as const

export type IpcChannel = (typeof ipcChannels)[keyof typeof ipcChannels]

export const createConversationRequestSchema = z.undefined()
export const listMessagesRequestSchema = z.object({ conversationId: identifierSchema }).strict()
export const renameConversationRequestSchema = z.object({
  conversationId: identifierSchema,
  title: nonEmptyStringSchema,
}).strict()
export const deleteConversationRequestSchema = z.object({ conversationId: identifierSchema }).strict()
export const cancelChatRequestSchema = z.object({ requestId: identifierSchema }).strict()
export const workflowListRequestSchema = workflowQuerySchema.optional()
export const workflowGetRequestSchema = z.object({
  id: identifierSchema,
  version: nonEmptyStringSchema.optional(),
}).strict()
export const workflowSetEnabledRequestSchema = z.object({ id: identifierSchema, version: nonEmptyStringSchema, enabled: z.boolean() }).strict()
export const workflowRemoveRequestSchema = z.object({ id: identifierSchema, version: nonEmptyStringSchema }).strict()
export const workflowInstallProjectRequestSchema = z.object({ projectId: identifierSchema }).strict()
export const createProjectRequestSchema = z.object({ name: nonEmptyStringSchema }).strict()
export const registerProjectRequestSchema = z.undefined()
export const readFileRequestSchema = z.object({
  projectId: identifierSchema,
  relativePath: nonEmptyStringSchema,
}).strict()
export const writeFileRequestSchema = readFileRequestSchema.extend({ content: z.string() })
export const validateProjectRequestSchema = z.object({ projectId: identifierSchema }).strict()
export const executionListRequestSchema = executionQuerySchema.optional()
export const getExecutionRequestSchema = z.object({ executionId: identifierSchema }).strict()
export const cancelExecutionRequestSchema = z.object({ executionId: identifierSchema }).strict()
export const revokePermissionRequestSchema = z.object({ grantId: identifierSchema }).strict()
export const settingsGetRequestSchema = z.undefined()
export const settingsUpdateRequestSchema = appSettingsPatchSchema
export const saveOpenRouterKeyRequestSchema = z.object({ apiKey: nonEmptyStringSchema }).strict()
export const clearOpenRouterKeyRequestSchema = z.undefined()
export const validateOpenRouterKeyRequestSchema = z.undefined()
export const listModelsRequestSchema = z.undefined()
export const clearLocalDataRequestSchema = z.object({
  scope: z.enum(['conversations', 'executions', 'all']),
}).strict()
export const openExternalRequestSchema = z.object({
  url: z.string().superRefine((value, context) => {
    try {
      const parsed = new URL(value)
      if (parsed.protocol !== 'https:'
        || parsed.username !== ''
        || parsed.password !== ''
        || parsed.port !== ''
        || parsed.href !== value) {
        context.addIssue({ code: 'custom', message: 'A canonical default-port HTTPS URL is required' })
      }
    } catch {
      context.addIssue({ code: 'custom', message: 'A canonical default-port HTTPS URL is required' })
    }
  }),
}).strict()

export const ipcRequestSchemas = {
  [ipcChannels.chatListConversations]: z.undefined(),
  [ipcChannels.chatListMessages]: listMessagesRequestSchema,
  [ipcChannels.chatCreateConversation]: createConversationRequestSchema,
  [ipcChannels.chatRenameConversation]: renameConversationRequestSchema,
  [ipcChannels.chatDeleteConversation]: deleteConversationRequestSchema,
  [ipcChannels.chatSend]: chatSendInputSchema,
  [ipcChannels.chatCancel]: cancelChatRequestSchema,
  [ipcChannels.workflowsList]: workflowListRequestSchema,
  [ipcChannels.workflowsGet]: workflowGetRequestSchema,
  [ipcChannels.workflowsSetEnabled]: workflowSetEnabledRequestSchema,
  [ipcChannels.workflowsRemove]: workflowRemoveRequestSchema,
  [ipcChannels.workflowsInstallProject]: workflowInstallProjectRequestSchema,
  [ipcChannels.developerCreateProject]: createProjectRequestSchema,
  [ipcChannels.developerRegisterProject]: registerProjectRequestSchema,
  [ipcChannels.developerReadFile]: readFileRequestSchema,
  [ipcChannels.developerWriteFile]: writeFileRequestSchema,
  [ipcChannels.developerBuildProject]: validateProjectRequestSchema,
  [ipcChannels.developerValidate]: validateProjectRequestSchema,
  [ipcChannels.developerRun]: developerRunInputSchema,
  [ipcChannels.executionsList]: executionListRequestSchema,
  [ipcChannels.executionsGet]: getExecutionRequestSchema,
  [ipcChannels.executionsDecide]: approvalDecisionSchema,
  [ipcChannels.executionsCancel]: cancelExecutionRequestSchema,
  [ipcChannels.permissionsListGrants]: z.undefined(),
  [ipcChannels.permissionsRevoke]: revokePermissionRequestSchema,
  [ipcChannels.settingsGet]: settingsGetRequestSchema,
  [ipcChannels.settingsUpdate]: settingsUpdateRequestSchema,
  [ipcChannels.settingsSaveOpenRouterKey]: saveOpenRouterKeyRequestSchema,
  [ipcChannels.settingsClearOpenRouterKey]: clearOpenRouterKeyRequestSchema,
  [ipcChannels.settingsValidateOpenRouterKey]: validateOpenRouterKeyRequestSchema,
  [ipcChannels.settingsListModels]: listModelsRequestSchema,
  [ipcChannels.settingsClearLocalData]: clearLocalDataRequestSchema,
  [ipcChannels.systemOpenExternal]: openExternalRequestSchema,
  [ipcChannels.systemGetAppInfo]: z.undefined(),
} as const

const voidResponseSchema = z.void()
const requestIdResponseSchema = z.object({ requestId: identifierSchema }).strict()
const executionIdResponseSchema = z.object({ executionId: identifierSchema }).strict()

export const ipcResponseSchemas = {
  [ipcChannels.chatListConversations]: z.array(conversationSummarySchema),
  [ipcChannels.chatListMessages]: z.array(chatMessageSchema),
  [ipcChannels.chatCreateConversation]: conversationSummarySchema,
  [ipcChannels.chatRenameConversation]: conversationSummarySchema,
  [ipcChannels.chatDeleteConversation]: voidResponseSchema,
  [ipcChannels.chatSend]: requestIdResponseSchema,
  [ipcChannels.chatCancel]: voidResponseSchema,
  [ipcChannels.workflowsList]: z.array(workflowSummarySchema),
  [ipcChannels.workflowsGet]: workflowDetailSchema,
  [ipcChannels.workflowsSetEnabled]: voidResponseSchema,
  [ipcChannels.workflowsRemove]: voidResponseSchema,
  [ipcChannels.workflowsInstallProject]: workflowDetailSchema,
  [ipcChannels.developerCreateProject]: developerProjectSchema,
  [ipcChannels.developerRegisterProject]: developerProjectSchema.nullable(),
  [ipcChannels.developerReadFile]: z.string(),
  [ipcChannels.developerWriteFile]: voidResponseSchema,
  [ipcChannels.developerBuildProject]: developerProjectSchema,
  [ipcChannels.developerValidate]: validationResultSchema,
  [ipcChannels.developerRun]: executionIdResponseSchema,
  [ipcChannels.executionsList]: z.array(executionSummarySchema),
  [ipcChannels.executionsGet]: executionDetailSchema,
  [ipcChannels.executionsDecide]: voidResponseSchema,
  [ipcChannels.executionsCancel]: voidResponseSchema,
  [ipcChannels.permissionsListGrants]: z.array(permissionGrantSchema),
  [ipcChannels.permissionsRevoke]: voidResponseSchema,
  [ipcChannels.settingsGet]: appSettingsSchema,
  [ipcChannels.settingsUpdate]: appSettingsSchema,
  [ipcChannels.settingsSaveOpenRouterKey]: credentialStatusSchema,
  [ipcChannels.settingsClearOpenRouterKey]: voidResponseSchema,
  [ipcChannels.settingsValidateOpenRouterKey]: credentialStatusSchema,
  [ipcChannels.settingsListModels]: z.array(modelInfoSchema),
  [ipcChannels.settingsClearLocalData]: voidResponseSchema,
  [ipcChannels.systemOpenExternal]: voidResponseSchema,
  [ipcChannels.systemGetAppInfo]: appInfoSchema,
} as const

export interface DesktopAPI {
  chat: {
    listConversations(): Promise<ConversationSummary[]>
    listMessages(conversationId: string): Promise<ChatMessage[]>
    createConversation(): Promise<ConversationSummary>
    renameConversation(conversationId: string, title: string): Promise<ConversationSummary>
    deleteConversation(conversationId: string): Promise<void>
    send(input: ChatSendInput): Promise<{ requestId: string }>
    cancel(requestId: string): Promise<void>
    onEvent(listener: (event: ChatEvent) => void): () => void
  }
  workflows: {
    list(query?: WorkflowQuery): Promise<WorkflowSummary[]>
    get(id: string, version?: string): Promise<WorkflowDetail>
    setEnabled(id: string, version: string, enabled: boolean): Promise<void>
    remove(id: string, version: string): Promise<void>
    installProject(projectId: string): Promise<WorkflowDetail>
  }
  developer: {
    createProject(name: string): Promise<DeveloperProject>
    registerProject(): Promise<DeveloperProject | null>
    readFile(projectId: string, relativePath: string): Promise<string>
    writeFile(projectId: string, relativePath: string, content: string): Promise<void>
    build(projectId: string): Promise<DeveloperProject>
    validate(projectId: string): Promise<ValidationResult>
    run(input: DeveloperRunInput): Promise<{ executionId: string }>
  }
  executions: {
    list(query?: ExecutionQuery): Promise<ExecutionSummary[]>
    get(executionId: string): Promise<ExecutionDetail>
    decide(input: ApprovalDecision): Promise<void>
    cancel(executionId: string): Promise<void>
    onEvent(listener: (event: ExecutionEvent) => void): () => void
  }
  permissions: {
    listGrants(): Promise<PermissionGrant[]>
    revoke(grantId: string): Promise<void>
  }
  settings: {
    get(): Promise<AppSettings>
    update(patch: AppSettingsPatch): Promise<AppSettings>
    saveOpenRouterKey(apiKey: string): Promise<CredentialStatus>
    clearOpenRouterKey(): Promise<void>
    validateOpenRouterKey(): Promise<CredentialStatus>
    listModels(): Promise<ModelInfo[]>
    clearLocalData(scope: 'conversations' | 'executions' | 'all'): Promise<void>
  }
  system: {
    openExternal(url: string): Promise<void>
    getAppInfo(): Promise<AppInfo>
  }
}
