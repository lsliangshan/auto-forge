import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  chatBlockSchema,
  conversationGenerationPreferencesSchema,
  openExternalRequestSchema,
  toSafeAppError,
  type AppError,
  type AppSettings,
  type AuthorizationSnapshot,
  type AuthSession,
  type ChatBlock,
  type ChatEvent,
  type DeveloperProject,
  type ExecutionDetail,
  type ExecutionEvent,
  type ExecutionQuery,
  type ExecutionSummary,
  type ModelProviderId,
  type PermissionGrant,
  type ProviderCredentialStatus,
  type WorkflowChatAvailability,
  type WorkflowDetail,
  type WorkflowQuery,
  type WorkflowSummary,
} from '@autoforge/shared'
import type { WorkflowManifest } from '@autoforge/workflow-schema'
import {
  AgentOrchestrator,
  createAgentPersistence,
  type AgentRunResult,
} from './agent/agent-orchestrator.js'
import type { AuthService } from './auth/auth-service.js'
import { createCloudBaseClientPorts, readCloudBaseAuthConfig } from './auth/cloudbase-auth-port.js'
import { CloudBaseAuthService } from './auth/cloudbase-auth-service.js'
import { CloudBaseRoleService, type BusinessRoleService } from './auth/cloudbase-role-service.js'
import { BrowserCapabilityService, PolicyEngineBrowserAuthorization } from './browser/browser-capability.js'
import type { BrowserWorkspacePort } from './browser/electron-browser-workspace.js'
import { DeepSeekProvider } from './chat/deepseek-provider.js'
import { createConversationContextManager } from './chat/conversation-context.js'
import type { ModelProvider, ModelProviderSnapshot } from './chat/model-provider.js'
import { ProviderDiagnosticLog } from './chat/provider-diagnostic-log.js'
import {
  credentialKeyForProvider,
  ModelProviderRegistry,
  type CredentialBoundModelProvider,
} from './chat/model-provider-registry.js'
import { OpenRouterProvider } from './chat/openrouter-provider.js'
import { MediaGenerationOrchestrator } from './chat/media-generation-orchestrator.js'
import { resolveChatRoute } from './chat/multimodal-router.js'
import type { ModelContentPart } from './chat/model-provider.js'
import { VideoJobRunner } from './chat/video-job-runner.js'
import { openAppDatabase } from './database/client.js'
import {
  ProviderUsageConsistencyError,
  type AppRepositories,
  type Execution,
  type WorkflowProject,
} from './database/repositories.js'
import type { CloudBaseIdentityRepository } from './database/cloudbase-identity-repository.js'
import { PolicyEngine } from './permissions/policy-engine.js'
import { SecretStore, type SafeStoragePort } from './security/secret-store.js'
import { SettingsService } from './settings/settings-service.js'
import { createMediaAssetService } from './media/media-asset-service.js'
import { ProviderUsageReconciler } from './billing/provider-usage-reconciler.js'
import { createProviderUsageReconciliationLoop } from './billing/provider-usage-reconciliation-loop.js'
import { MediaLifecycle } from './media/media-lifecycle.js'
import { PinnedMediaTransport, type PinnedMediaTransportPort } from './media/pinned-media-transport.js'
import { SafeMediaDownloader } from './media/safe-download.js'
import type { NetworkProxyPort } from './network/network-proxy-service.js'
import { removeInterruptedRuntimeDirectories } from './startup.js'
import { createTokenUsageSnapshot } from './token-usage.js'
import { QiniuAvatarUploader } from './profile/avatar-uploader.js'
import { ProfileService } from './profile/profile-service.js'
import { QiniuFileUploader, readQiniuConfig } from './upload/qiniu-file-uploader.js'
import { UserAdminService } from './user-admin/user-admin-service.js'
import {
  ExecutionService,
  NodeWorkerFactory,
  type WorkflowExecutionSource,
  type WorkflowExecutionSourceResolver,
} from './workflows/execution-service.js'
import { validateWorkflowInput } from './workflows/input-validation.js'
import { WorkflowProjectService } from './workflows/project-service.js'
import { WorkflowRegistry } from './workflows/registry.js'
import {
  createWorkflowSourceSelectorVault,
  type ExactWorkflowSource,
  type WorkflowSourceSelectorVault,
} from './workflows/workflow-source-selector.js'
import type { DesktopIpcServices } from './ipc/register-ipc.js'

export interface ApplicationPaths {
  database: string
  data: string
  logs: string
  projects: string
  installations: string
  workflowRunner: string
  temporary: string
}

export type ApplicationModelProviderPort = CredentialBoundModelProvider

type ApplicationFailureSource =
  | 'background-chat'
  | 'preflight'
  | 'video-submit'
  | 'video-background'
  | 'reconciliation-stop'
  | 'video-stop'
  | 'admission-drain'
  | 'agent-cancel'
  | 'media-cancel'
  | 'chat-drain'
  | 'execution-shutdown'
  | 'database-close'

interface ApplicationFailureRecord {
  error: unknown
  sequence: number
  rank: number
}

const applicationFailureRank: Record<ApplicationFailureSource, number> = {
  'background-chat': 0,
  preflight: 1,
  'video-submit': 2,
  'video-background': 3,
  'reconciliation-stop': 10,
  'video-stop': 20,
  'admission-drain': 30,
  'agent-cancel': 40,
  'media-cancel': 50,
  'chat-drain': 60,
  'execution-shutdown': 70,
  'database-close': 80,
}

/** @internal Exported only for direct unit coverage of failure identity semantics. */
export function createApplicationFailureRecorder(
  onConsistency: (error: ProviderUsageConsistencyError) => void,
) {
  const records: ApplicationFailureRecord[] = []
  const observed = new Set<unknown>()
  let sequence = 0
  return {
    record: (error: unknown, source: ApplicationFailureSource): void => {
      if (observed.has(error)) return
      observed.add(error)
      records.push({ error, sequence: sequence++, rank: applicationFailureRank[source] })
      if (error instanceof ProviderUsageConsistencyError) onConsistency(error)
    },
    select: (): { error: unknown } | undefined => {
      const consistency = records.find(({ error }) => error instanceof ProviderUsageConsistencyError)
      const selected = consistency ?? [...records]
        .sort((left, right) => left.rank - right.rank || left.sequence - right.sequence)[0]
      return selected === undefined ? undefined : { error: selected.error }
    },
  }
}

export interface ApplicationRuntimeOptions {
  paths: ApplicationPaths
  safeStorage: SafeStoragePort
  authService?: AuthService
  roleService?: BusinessRoleService
  cloudbaseEnv?: NodeJS.ProcessEnv
  networkProxy: NetworkProxyPort
  mediaTransport?: PinnedMediaTransportPort
  modelProviders?: Partial<Record<ModelProviderId, ApplicationModelProviderPort>>
  chooseProjectDirectory(): Promise<string | undefined>
  chooseMediaFiles(remainingSlots: number): Promise<string[]>
  chooseAvatarFile?: () => Promise<string | undefined>
  qiniuEnv?: NodeJS.ProcessEnv
  readClipboardImage(): { bytes: Uint8Array; mimeType: 'image/png'; name: string } | undefined
  chooseMediaSavePath(defaultName: string): Promise<string | undefined>
  revealPath(path: string): void
  openExternal(url: string): Promise<void>
  emitChat(event: ChatEvent): void
  emitExecution(event: ExecutionEvent): void
  browserWorkspace: BrowserWorkspacePort
  applyTheme?(theme: AppSettings['theme']): void
  appInfo?: { version: string; platform: 'darwin' | 'win32' }
  removeExecutionTemporaryDirectory?(path: string): Promise<void>
}

interface ObservedAuthService extends AuthService {
  isAuthenticated(): boolean
  currentUserId(): string | undefined
  refreshAuthorization(): Promise<AuthSession>
}

/** @internal Exported for direct failure-state verification. */
export function observeAuthService(
  delegate: AuthService,
  identities: Pick<CloudBaseIdentityRepository, 'sync'> & { clearSession(): void },
  roles?: Pick<BusinessRoleService, 'ensureMyRole'>,
): ObservedAuthService {
  let authenticated = false
  let currentUserId: string | undefined
  let currentAuthorization: AuthorizationSnapshot | undefined
  const clearLocalSession = (): void => {
    try {
      identities.clearSession()
    } catch {
      throw failure('INTERNAL_ERROR')
    }
  }
  const fallbackAuthorization = (session: AuthSession): AuthorizationSnapshot => (
    session.authorization?.confirmed === true
      ? session.authorization
      : {
          role: 'user',
          capabilities: [],
          version: 0,
          updatedAt: session.authenticatedAt,
          confirmed: true,
        }
  )
  const resolveAuthorization = async (session: AuthSession): Promise<AuthorizationSnapshot> => (
    roles ? roles.ensureMyRole() : fallbackAuthorization(session)
  )
  const synchronize = async (
    session: AuthSession,
    authorization: AuthorizationSnapshot,
  ): Promise<AuthSession> => {
    const authorizedSession = { ...session, authorization }
    try {
      identities.sync(authorizedSession, Date.now())
      authenticated = true
      currentUserId = session.user.id
      currentAuthorization = authorization
      return authorizedSession
    } catch {
      authenticated = false
      currentUserId = undefined
      currentAuthorization = undefined
      let rollbackFailed = false
      try {
        await delegate.discardSession()
      } catch {
        rollbackFailed = true
      }
      try {
        identities.clearSession()
      } catch {
        rollbackFailed = true
      }
      void rollbackFailed
      throw failure('INTERNAL_ERROR')
    }
  }
  const authorizeAndSynchronize = async (session: AuthSession): Promise<AuthSession> => {
    let authorization: AuthorizationSnapshot
    try {
      authorization = await resolveAuthorization(session)
    } catch (error) {
      try { await delegate.discardSession() } catch { /* Best effort after role failure. */ }
      authenticated = false
      currentUserId = undefined
      currentAuthorization = undefined
      clearLocalSession()
      throw toSafeAppError(error)
    }
    return synchronize(session, authorization)
  }
  return {
    async getSession() {
      const session = await delegate.getSession()
      if (session === null) {
        authenticated = false
        currentUserId = undefined
        currentAuthorization = undefined
        clearLocalSession()
        return null
      }
      return authorizeAndSynchronize(session)
    },
    sendOtp: (input) => delegate.sendOtp(input),
    verifyOtp: async (input) => authorizeAndSynchronize(await delegate.verifyOtp(input)),
    cancelOtp: (challengeId) => delegate.cancelOtp(challengeId),
    loginWithPassword: async (input) => authorizeAndSynchronize(await delegate.loginWithPassword(input)),
    updateUserProfile: (input) => delegate.updateUserProfile(input),
    async discardSession() {
      try {
        await delegate.discardSession()
      } finally {
        authenticated = false
        currentUserId = undefined
        currentAuthorization = undefined
        clearLocalSession()
      }
    },
    async logout() {
      await delegate.logout()
      authenticated = false
      currentUserId = undefined
      currentAuthorization = undefined
      clearLocalSession()
    },
    requireSession: async () => {
      const session = await delegate.requireSession()
      if (currentAuthorization && currentUserId === session.user.id) {
        return { ...session, authorization: currentAuthorization }
      }
      return synchronize(session, await resolveAuthorization(session))
    },
    async refreshAuthorization() {
      const session = await delegate.requireSession()
      try {
        return await synchronize(session, await resolveAuthorization(session))
      } catch {
        const authorization: AuthorizationSnapshot = {
          role: currentAuthorization?.role ?? 'user',
          capabilities: [],
          version: currentAuthorization?.version ?? 0,
          updatedAt: currentAuthorization?.updatedAt ?? session.authenticatedAt,
          confirmed: false,
        }
        authenticated = true
        currentUserId = session.user.id
        currentAuthorization = authorization
        return { ...session, authorization }
      }
    },
    isAuthenticated: () => authenticated,
    currentUserId: () => currentUserId,
  }
}

function failure(code: AppError['code']): AppError {
  return toSafeAppError({ code })
}

const defaultGenerationPreferences = conversationGenerationPreferencesSchema.parse({
  outputType: 'auto',
  models: {},
  generation: { image: { count: 1 }, audio: {}, video: {} },
})

export class MaintenanceGate {
  private maintenance = false
  private starts = 0
  private stopped = false
  private readonly drainWaiters = new Set<() => void>()

  private resolveDrainWaiters(): void {
    if (this.starts !== 0 || this.maintenance) return
    for (const resolve of this.drainWaiters) resolve()
    this.drainWaiters.clear()
  }

  beginStart(): () => void {
    if (this.maintenance || this.stopped) throw failure('CONFLICT')
    this.starts += 1
    let active = true
    return () => {
      if (!active) return
      active = false
      this.starts -= 1
      this.resolveDrainWaiters()
    }
  }

  clearLocalData(hasActiveWork: () => boolean, clear: () => void): void {
    if (this.maintenance || this.stopped) throw failure('CONFLICT')
    this.maintenance = true
    try {
      if (this.starts > 0 || hasActiveWork()) throw failure('CONFLICT')
      clear()
    } finally {
      this.maintenance = false
      this.resolveDrainWaiters()
    }
  }

  async runExclusive<T>(hasActiveWork: () => boolean, operation: () => Promise<T>): Promise<T> {
    if (this.maintenance || this.stopped) throw failure('CONFLICT')
    this.maintenance = true
    try {
      if (this.starts > 0 || hasActiveWork()) throw failure('CONFLICT')
      return await operation()
    } finally {
      this.maintenance = false
      this.resolveDrainWaiters()
    }
  }

  async stopAndDrain(): Promise<void> {
    this.stopped = true
    if (this.starts === 0 && !this.maintenance) return
    await new Promise<void>((resolve) => {
      this.drainWaiters.add(resolve)
    })
  }
}

function iso(timestamp: number | undefined): string | undefined {
  return timestamp === undefined ? undefined : new Date(timestamp).toISOString()
}

function summary(workflow: WorkflowDetail): WorkflowSummary {
  return {
    id: workflow.id,
    version: workflow.version,
    name: workflow.name,
    description: workflow.description,
    author: workflow.author,
    category: workflow.category,
    enabled: workflow.enabled,
    source: workflow.source,
    integrity: workflow.integrity,
    updatedAt: workflow.updatedAt,
  }
}

function projectEntries(root: string): Promise<{ files: string[]; directories: string[] }> {
  const ignoredDirectories = new Set(['.git', 'node_modules'])
  const visit = async (directory: string, prefix = ''): Promise<{ files: string[]; directories: string[] }> => {
    const entries = await readdir(directory, { withFileTypes: true })
    const nested = await Promise.all(entries.filter((entry) => !entry.isSymbolicLink()
      && !(entry.isDirectory() && ignoredDirectories.has(entry.name))).map(async (entry) => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (!entry.isDirectory()) return { files: [relative], directories: [] }
      const children = await visit(join(directory, entry.name), relative)
      return { files: children.files, directories: [relative, ...children.directories] }
    }))
    return {
      files: nested.flatMap(({ files }) => files).sort(),
      directories: nested.flatMap(({ directories }) => directories).sort(),
    }
  }
  return visit(root)
}

async function developerProject(project: WorkflowProject): Promise<DeveloperProject> {
  const entries = await projectEntries(project.rootPath)
  const status = ['new', 'building', 'ready', 'invalid', 'error'].includes(project.status)
    ? project.status as DeveloperProject['status']
    : 'error'
  const chatAvailability: WorkflowChatAvailability = status === 'invalid' || status === 'error'
    ? 'invalid'
    : !project.buildHash
      ? 'not_built'
      : status === 'ready'
        ? 'ready'
        : 'unbuilt_changes'
  return {
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
    status,
    chatAvailability,
    ...entries,
    updatedAt: new Date(project.updatedAt).toISOString(),
  }
}

export interface WorkflowExecutionSourceResolverDependencies {
  repositories: Pick<AppRepositories, 'workflowProjects' | 'installedWorkflows'>
  registry: Pick<WorkflowRegistry, 'get' | 'getDevelopmentProject' | 'verifyIntegrity'>
}

function matchingDevelopmentSource(
  project: WorkflowProject,
  workflow: WorkflowDetail | undefined,
  exact: Extract<ExactWorkflowSource, { source: 'development' }>,
): WorkflowExecutionSource | undefined {
  const manifest = project.manifest as Partial<WorkflowManifest> | undefined
  if (!workflow
    || project.status !== 'ready'
    || project.buildHash !== exact.buildHash
    || manifest?.id !== exact.id
    || manifest.version !== exact.version
    || typeof manifest.entryPath !== 'string'
    || manifest.codeSha256 !== workflow.codeSha256
    || workflow.id !== exact.id
    || workflow.version !== exact.version
    || workflow.source !== 'development'
    || workflow.runtimeIdentity.source !== 'development'
    || workflow.runtimeIdentity.buildHash !== exact.buildHash) return undefined
  return { workflow, rootPath: project.rootPath, entryPath: manifest.entryPath, integrity: workflow.integrity }
}

export function createWorkflowExecutionSourceResolver(
  selectors: WorkflowSourceSelectorVault,
  dependencies: WorkflowExecutionSourceResolverDependencies,
): WorkflowExecutionSourceResolver {
  return {
    async resolve(id, version, selector) {
      const exact = selectors.inspect(selector)
      if (!exact || exact.id !== id || exact.version !== version) return undefined
      if (exact.source === 'development') {
        const matches = (await Promise.all(dependencies.repositories.workflowProjects.list().map(async (project) => (
          matchingDevelopmentSource(project, await dependencies.registry.getDevelopmentProject(project.id), exact)
        )))).filter((source): source is WorkflowExecutionSource => source !== undefined)
        return matches.length === 1 ? matches[0] : undefined
      }

      const installed = dependencies.repositories.installedWorkflows.get(id, version)
      const manifest = installed?.manifest as Partial<WorkflowManifest> | undefined
      if (!installed
        || manifest?.id !== exact.id
        || manifest.version !== exact.version
        || manifest.codeSha256 !== exact.codeSha256) return undefined
      const integrity = await dependencies.registry.verifyIntegrity(id, version)
      const workflow = await dependencies.registry.get(id, version, { developerMode: false })
      if (!integrity.valid
        || !workflow
        || workflow.id !== exact.id
        || workflow.version !== exact.version
        || workflow.source !== 'installed'
        || workflow.runtimeIdentity.source !== 'installed'
        || workflow.codeSha256 !== exact.codeSha256) return undefined
      return { workflow, rootPath: installed.installPath, entryPath: String(manifest.entryPath), integrity: workflow.integrity }
    },
  }
}

function workflowId(name: string): string {
  const label = name.normalize('NFKD').toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return `local.autoforge.${label || randomUUID().replaceAll('-', '').slice(0, 12)}`
}

function newManifest(name: string): WorkflowManifest {
  return {
    id: workflowId(name),
    version: '0.1.0',
    name,
    description: '',
    author: 'Local developer',
    category: 'local',
    cities: [],
    entryPath: 'dist/index.js',
    codeSha256: '0'.repeat(64),
    permissions: [],
    activationExamples: [name],
    activationNegativeExamples: [],
    timeoutMs: 30_000,
    inputSchema: { type: 'object', additionalProperties: true },
    outputSchema: {},
  }
}

function executionSummary(execution: Execution): ExecutionSummary {
  return {
    id: execution.id,
    workflowId: execution.workflowId,
    workflowVersion: execution.workflowVersion,
    status: execution.status as ExecutionSummary['status'],
    ...(iso(execution.startedAt) ? { startedAt: iso(execution.startedAt) } : {}),
    ...(iso(execution.endedAt) ? { finishedAt: iso(execution.endedAt) } : {}),
    createdAt: new Date(execution.createdAt).toISOString(),
  }
}

export function createApplicationRuntime(options: ApplicationRuntimeOptions) {
  const database = openAppDatabase(options.paths.database)
  const secretStore = new SecretStore(database.encryptedSecrets, options.safeStorage)
  const cloudBasePorts = options.authService
    ? undefined
    : createCloudBaseClientPorts(readCloudBaseAuthConfig(options.cloudbaseEnv ?? process.env))
  const baseAuthService = options.authService
    ?? new CloudBaseAuthService(cloudBasePorts!.auth, secretStore)
  const roleService = options.roleService
    ?? (cloudBasePorts ? new CloudBaseRoleService(cloudBasePorts.functions) : undefined)
  const auth = observeAuthService(
    baseAuthService,
    {
      sync: (session, timestamp) => database.cloudBaseIdentities.sync(session, timestamp),
      clearSession: () => database.localAuth.clearSession(),
    },
    roleService,
  )
  const userAdmin = new UserAdminService(auth, roleService ?? {
    listUsers: async () => { throw failure('SERVICE_UNAVAILABLE') },
    updateUserRole: async () => { throw failure('SERVICE_UNAVAILABLE') },
  })
  const profiles = new ProfileService(auth, database.userProfiles)
  const qiniuUploader = new QiniuFileUploader({
    config: () => readQiniuConfig(options.qiniuEnv ?? process.env),
  })
  const avatarUploader = new QiniuAvatarUploader({
    chooseAvatar: options.chooseAvatarFile ?? (async () => undefined),
    upload: qiniuUploader,
  })
  const maintenance = new MaintenanceGate()
  const providerDiagnostics = new ProviderDiagnosticLog(options.paths.logs)
  const settings = new SettingsService(database.appSettings, {
    theme: 'system',
    language: 'zh-CN',
    dataDirectory: options.paths.data,
    logDirectory: options.paths.logs,
    activeProvider: 'deepseek',
    defaultModels: {
      openrouter: { text: 'openai/gpt-4.1-mini' },
      deepseek: { text: 'deepseek-v4-flash' },
    },
    showCosts: true,
    developerMode: false,
    permissionDefault: 'ask',
    proxy: { enabled: false, bypassDomains: [] },
  })
  options.applyTheme?.(settings.get().theme)
  const providerRegistry = new ModelProviderRegistry({
    openrouter: options.modelProviders?.openrouter ?? new OpenRouterProvider({
      credential: secretStore,
      fetch: options.networkProxy.fetch.bind(options.networkProxy) as typeof globalThis.fetch,
      diagnostic: providerDiagnostics.forProvider('openrouter'),
    }),
    deepseek: options.modelProviders?.deepseek ?? new DeepSeekProvider({
      credential: secretStore,
      fetch: options.networkProxy.fetch.bind(options.networkProxy) as typeof globalThis.fetch,
      diagnostic: providerDiagnostics.forProvider('deepseek'),
    }),
  })
  const providerUsageReconciler = new ProviderUsageReconciler({
    providerUsage: database.providerUsage,
    providers: providerRegistry,
  })
  const projects = new WorkflowProjectService(database, options.paths.installations)
  const registry = new WorkflowRegistry(database, projects)
  const media = createMediaAssetService({ database, mediaRoot: join(options.paths.data, 'media') })
  const mediaLifecycle = new MediaLifecycle({
    database,
    mediaRoot: join(options.paths.data, 'media'),
  })
  const providerCredentialEpoch = new Map<ModelProviderId, number>()
  const modelCatalog = new Map<ModelProviderId, {
    credentialEpoch: number
    promise: Promise<Awaited<ReturnType<ModelProvider['listModels']>>>
  }>()
  const getModelCatalog = (
    provider: ModelProviderId,
    refresh = false,
    acquired?: ModelProviderSnapshot,
    credentialEpoch = providerCredentialEpoch.get(provider) ?? 0,
  ) => {
    if (refresh) modelCatalog.delete(provider)
    let entry = modelCatalog.get(provider)
    if (entry?.credentialEpoch !== credentialEpoch) entry = undefined
    if (!entry) {
      const request = (async () => {
        const providerSnapshot = acquired ?? await providerRegistry.acquire(provider)
        if (providerSnapshot.providerId !== provider) throw new ProviderUsageConsistencyError()
        return providerSnapshot.provider.listModels()
      })()
      const catalog = request.catch((error) => {
        if (modelCatalog.get(provider)?.promise === catalog) modelCatalog.delete(provider)
        throw error
      })
      entry = { credentialEpoch, promise: catalog }
      if ((providerCredentialEpoch.get(provider) ?? 0) === credentialEpoch) {
        modelCatalog.set(provider, entry)
      }
    }
    return entry.promise
  }
  const sourceSelectorVault = createWorkflowSourceSelectorVault()
  const policy = new PolicyEngine(database.permissionGrants)
  const browser = new BrowserCapabilityService({
    authorization: new PolicyEngineBrowserAuthorization(policy),
    workspace: options.browserWorkspace,
    currentUserId: async () => (await auth.getSession())?.user.id,
  })
  const sourceResolver = createWorkflowExecutionSourceResolver(sourceSelectorVault, {
    repositories: database,
    registry,
  })

  const activeExecutions = new Set<string>()
  const activeRequests = new Set<string>()
  const activeChatWork = new Map<string, {
    conversationId: string
    promise: Promise<void>
  }>()
  let acceptingWork = true
  const failureRecorder = createApplicationFailureRecorder(() => { acceptingWork = false })
  const recordFailure = failureRecorder.record
  const providerUsageReconciliationLoop = createProviderUsageReconciliationLoop(
    providerUsageReconciler,
    (error) => { recordFailure(error, 'reconciliation-stop') },
  )
  const trackChatWork = (
    requestId: string,
    conversationId: string,
    operation: () => Promise<AgentRunResult>,
  ): void => {
    activeRequests.add(requestId)
    const promise = Promise.resolve()
      .then(operation)
      .then((result) => {
        if (['completed', 'cancelled', 'failed'].includes(result.status)) {
          activeRequests.delete(requestId)
        }
      }, (error: unknown) => {
        recordFailure(error, 'background-chat')
        activeRequests.delete(requestId)
      })
      .finally(() => {
        activeChatWork.delete(requestId)
      })
    activeChatWork.set(requestId, { conversationId, promise })
  }
  const emitExecution = (event: ExecutionEvent) => {
    if (event.type === 'status') {
      if (['queued', 'awaiting_approval', 'running'].includes(event.status)) activeExecutions.add(event.executionId)
      else activeExecutions.delete(event.executionId)
    }
    if (auth.isAuthenticated()) {
      try { options.emitExecution(event) } catch { /* Renderer events are observational. */ }
    }
  }
  const executions = new ExecutionService({
    repositories: database,
    sourceResolver,
    policy,
    workers: new NodeWorkerFactory(options.paths.workflowRunner),
    capability: browser,
    emit: emitExecution,
    temporaryDirectories: {
      create: async () => { await mkdir(options.paths.temporary, { recursive: true }); return mkdtemp(join(options.paths.temporary, 'autoforge-execution-')) },
      remove: options.removeExecutionTemporaryDirectory
        ?? ((path) => rm(path, { recursive: true, force: true })),
    },
  })
  const emitChat = (event: ChatEvent) => {
    if (event.type === 'status' && ['completed', 'cancelled', 'failed'].includes(event.status)) {
      activeRequests.delete(event.requestId)
      providerUsageReconciliationLoop.notifyUsageEnded()
    }
    const ownerId = database.conversations.get(event.conversationId)?.userId
    const belongsToCurrentUser = ownerId !== undefined && ownerId === auth.currentUserId()
    if (belongsToCurrentUser && event.type === 'block' && event.block.type === 'approval') {
      emitExecution({
        type: 'approval_required',
        executionId: event.block.executionId,
        permissionIndex: event.block.permissionIndex,
        capability: event.block.capability,
        scope: event.block.scope,
        scopeHash: event.block.scopeHash,
        occurredAt: new Date().toISOString(),
      })
    }
    if (belongsToCurrentUser) {
      try { options.emitChat(event) } catch { /* Renderer events are observational. */ }
    }
  }
  const conversationContext = createConversationContextManager(database)
  const agent = new AgentOrchestrator({
    workflows: registry,
    persistence: createAgentPersistence(database),
    history: conversationContext,
    policy,
    executions,
    createSourceSelector: sourceSelectorVault.create,
    providerUsage: database.providerUsage,
    emit: emitChat,
    developerMode: () => settings.get().developerMode,
  })
  const persistence = createAgentPersistence(database)
  const mediaGeneration = new MediaGenerationOrchestrator({
    providers: providerRegistry,
    persistence,
    media,
    downloader: new SafeMediaDownloader({
      transport: options.mediaTransport ?? new PinnedMediaTransport(),
      withTransportLease: options.networkProxy.withTransportLease.bind(options.networkProxy),
    }),
    providerUsage: database.providerUsage,
    emit: emitChat,
  })
  const videoJobs = new VideoJobRunner({
    database,
    providerUsage: database.providerUsage,
    providers: providerRegistry,
    media,
    emit: emitChat,
    onBackgroundFailure: (error) => { recordFailure(error, 'video-background') },
  })

  const requireValidCredential = async (snapshot: ModelProviderSnapshot): Promise<void> => {
    const result = await snapshot.provider.validateCredential()
    if (!result.valid) throw failure('CREDENTIAL_INVALID')
  }

  const resolvedInput = async (conversationId: string, assetIds: string[]) => {
    const assets = await Promise.all(assetIds.map((assetId) => (
      media.resolveReadyAsset(assetId, conversationId)
    )))
    const userBlocks: ChatBlock[] = [
      ...assets.map((asset): Extract<ChatBlock, { type: 'media' }> => ({
        type: 'media',
        blockId: randomUUID(),
        assetId: asset.id,
        kind: asset.kind,
        purpose: 'input',
        name: asset.name,
        mimeType: asset.mimeType,
        byteSize: asset.byteSize,
        ...(asset.width === undefined ? {} : { width: asset.width }),
        ...(asset.height === undefined ? {} : { height: asset.height }),
        ...(asset.durationMs === undefined ? {} : { durationMs: asset.durationMs }),
      })),
    ]
    return { assets, userBlocks }
  }

  const credentialStatus = async (provider: ModelProviderId): Promise<ProviderCredentialStatus> => {
    const configured = database.encryptedSecrets.raw(credentialKeyForProvider(provider)) !== undefined
    if (!configured) return { provider, configured: false, validation: 'unchecked' }
    try {
      const result = await (await providerRegistry.acquire(provider)).provider.validateCredential()
      return {
        provider,
        configured: true,
        validation: result.valid ? 'valid' : 'invalid',
        checkedAt: new Date().toISOString(),
      }
    } catch (error) {
      const safe = toSafeAppError(error)
      return {
        provider,
        configured: true,
        validation: safe.code === 'CREDENTIAL_INVALID'
          ? 'invalid'
          : safe.code === 'MODEL_PROVIDER_ACCESS_DENIED' ? 'denied' : 'unavailable',
        message: safe.message,
        checkedAt: new Date().toISOString(),
      }
    }
  }

  const requireOwnedConversation = (conversationId: string, userId: string) => {
    const conversation = database.conversations.get(conversationId)
    if (!conversation || conversation.userId !== userId) throw failure('NOT_FOUND')
    return conversation
  }

  let settingsUpdateTail = Promise.resolve()
  const services: DesktopIpcServices = {
    auth: {
      getSession: () => auth.getSession(),
      refreshAuthorization: () => auth.refreshAuthorization(),
      sendOtp: (input) => auth.sendOtp(input),
      verifyOtp: (input) => auth.verifyOtp(input),
      cancelOtp: (challengeId) => auth.cancelOtp(challengeId),
      loginWithPassword: (input) => auth.loginWithPassword(input),
      logout: () => auth.logout(),
      requireSession: () => auth.requireSession(),
    },
    userAdmin: {
      list: (input) => userAdmin.list(input),
      updateRole: (input) => userAdmin.updateRole(input),
    },
    profile: {
      get: () => profiles.get(),
      update: (input) => profiles.update(input),
      pickAndUploadAvatar: async () => {
        const session = await auth.requireSession()
        return avatarUploader.pickAndUpload(session.user.id)
      },
    },
    chat: {
      listConversations: async () => {
        const session = await auth.requireSession()
        return database.conversations.claimLegacyAndListForUser(session.user.id).map((conversation) => ({
          id: conversation.id,
          title: conversation.title,
          createdAt: new Date(conversation.createdAt).toISOString(),
          updatedAt: new Date(conversation.updatedAt).toISOString(),
        }))
      },
      listMessages: async (conversationId) => {
        const session = await auth.requireSession()
        requireOwnedConversation(conversationId, session.user.id)
        return database.messages.listForConversation(conversationId).map((message) => {
          if (message.role !== 'user' && message.role !== 'assistant') throw failure('INTERNAL_ERROR')
          return {
            id: message.id,
            conversationId: message.conversationId,
            role: message.role,
            blocks: chatBlockSchema.array().parse(message.blocks),
            ...(message.executionId ? { executionId: message.executionId } : {}),
            createdAt: new Date(message.createdAt).toISOString(),
          }
        })
      },
      createConversation: async () => {
        const session = await auth.requireSession()
        const conversation = database.conversations.insert({ id: randomUUID(), title: '新会话', userId: session.user.id })
        return {
          id: conversation.id,
          title: conversation.title,
          createdAt: new Date(conversation.createdAt).toISOString(),
          updatedAt: new Date(conversation.updatedAt).toISOString(),
        }
      },
      renameConversation: async (conversationId, title) => {
        const session = await auth.requireSession()
        requireOwnedConversation(conversationId, session.user.id)
        const conversation = database.conversations.update(conversationId, { title })
        if (!conversation) throw failure('NOT_FOUND')
        return {
          id: conversation.id,
          title: conversation.title,
          createdAt: new Date(conversation.createdAt).toISOString(),
          updatedAt: new Date(conversation.updatedAt).toISOString(),
        }
      },
      deleteConversation: async (conversationId) => {
        const session = await auth.requireSession()
        requireOwnedConversation(conversationId, session.user.id)
        return maintenance.runExclusive(
          () => [...activeChatWork.values()].some((work) => work.conversationId === conversationId)
            || database.mediaGenerationJobs.listActive()
              .some((job) => job.conversationId === conversationId),
          () => mediaLifecycle.deleteConversation(conversationId),
        )
      },
      send: async (input) => {
        const session = await auth.requireSession()
        const releaseStart = maintenance.beginStart()
        try {
          if (!acceptingWork) throw failure('CONFLICT')
          const conversation = requireOwnedConversation(input.conversationId, session.user.id)
          const snapshot = settings.get()
          const preferences = conversationGenerationPreferencesSchema.parse(
            conversation.generationPreferences ?? defaultGenerationPreferences,
          )
          const requestedOutput = input.outputType === 'auto'
            ? preferences.outputType
            : input.outputType
          if (
            snapshot.activeProvider === 'deepseek'
            && (input.assetIds.length > 0
              || (requestedOutput !== 'auto' && requestedOutput !== 'text'))
          ) throw failure('MODEL_MODALITY_UNSUPPORTED')
          const credentialEpoch = providerCredentialEpoch.get(snapshot.activeProvider) ?? 0
          const providerSnapshot = await providerRegistry.acquire(snapshot.activeProvider)
          if (providerSnapshot.providerId !== snapshot.activeProvider) {
            const error = new ProviderUsageConsistencyError()
            recordFailure(error, 'preflight')
            throw error
          }
          await requireValidCredential(providerSnapshot)
          const resolved = await resolvedInput(input.conversationId, input.assetIds)
          const route = resolveChatRoute({
            provider: snapshot.activeProvider,
            ...(input.model === undefined ? {} : { requestedModel: input.model }),
            requestedOutput: input.outputType,
            requestedGeneration: input.generation,
            defaults: snapshot.defaultModels,
            conversationPreferences: preferences,
            models: await getModelCatalog(
              snapshot.activeProvider,
              false,
              providerSnapshot,
              credentialEpoch,
            ),
            assets: resolved.assets,
          })
          if ('selectionRequired' in route || 'modelRequired' in route) {
            throw failure('INVALID_INPUT')
          }
          const requestId = randomUUID()
          const userBlocks: ChatBlock[] = [
            ...(input.content ? [{ type: 'text' as const, text: input.content }] : []),
            ...resolved.userBlocks,
          ]
          const generationInput = {
            requestId,
            conversationId: input.conversationId,
            prompt: input.content,
            userBlocks,
            assetIds: input.assetIds,
            route,
            userId: session.user.id,
          }
          if (route.outputType === 'text') {
            const modelInputs = await media.modelInput(input.conversationId, input.assetIds)
            const modelContent: string | ModelContentPart[] = modelInputs.length === 0
              ? input.content
              : [
                  { type: 'text', text: input.content },
                  ...modelInputs.map(({ kind, mimeType, dataBase64 }) => ({
                    type: 'media' as const,
                    kind,
                    mimeType,
                    dataBase64,
                  })),
                ]
            trackChatWork(requestId, input.conversationId, async () => {
              return agent.run({
                conversationId: input.conversationId,
                content: input.content,
                userBlocks,
                modelContent,
                assetIds: input.assetIds,
                currentMedia: resolved.assets.map(({ kind, durationMs }) => ({
                  kind,
                  ...(durationMs === undefined ? {} : { durationMs }),
                })),
                allowTools: route.supportsTools,
                userId: session.user.id,
                providerSnapshot,
                provider: route.provider,
                model: route.model,
                ...(route.contextLength === undefined ? {} : { contextLength: route.contextLength }),
                requestId,
              })
            })
          } else if (route.outputType === 'image') {
            trackChatWork(requestId, input.conversationId, async () => {
              return mediaGeneration.runImage(generationInput)
            })
          } else if (route.outputType === 'audio') {
            trackChatWork(requestId, input.conversationId, async () => {
              return mediaGeneration.runAudio(generationInput)
            })
          } else {
            try {
              await videoJobs.submit({
                ...generationInput,
                route: { ...route, outputType: 'video' },
              })
            } catch (error) {
              if (error instanceof ProviderUsageConsistencyError) {
                recordFailure(error, 'video-submit')
              }
              throw error
            }
          }
          return { requestId }
        } finally {
          releaseStart()
        }
      },
      cancel: async (requestId) => {
        const session = await auth.requireSession()
        const conversationId = activeChatWork.get(requestId)?.conversationId
          ?? database.chatRuns.getByRequestId(requestId)?.conversationId
        if (!conversationId) throw failure('NOT_FOUND')
        requireOwnedConversation(conversationId, session.user.id)
        await Promise.allSettled([
          agent.cancel(requestId),
          mediaGeneration.cancel(requestId),
        ])
      },
      getGenerationPreferences: async (conversationId) => {
        const session = await auth.requireSession()
        const conversation = requireOwnedConversation(conversationId, session.user.id)
        return conversationGenerationPreferencesSchema.parse(
          conversation.generationPreferences ?? defaultGenerationPreferences,
        )
      },
      updateGenerationPreferences: async (conversationId, preferences) => {
        const session = await auth.requireSession()
        requireOwnedConversation(conversationId, session.user.id)
        const normalized = conversationGenerationPreferencesSchema.safeParse(preferences)
        if (!normalized.success) throw failure('INVALID_INPUT')
        const conversation = database.conversations.updateGenerationPreferences(conversationId, normalized.data)
        if (!conversation?.generationPreferences) throw failure('NOT_FOUND')
        return conversationGenerationPreferencesSchema.parse(conversation.generationPreferences)
      },
    },
    media: {
      pickFiles: async (context) => {
        const session = await auth.requireSession()
        requireOwnedConversation(context.conversationId, session.user.id)
        const remainingSlots = 5 - context.existingAssetIds.length
        if (remainingSlots <= 0) return []
        const paths = (await options.chooseMediaFiles(remainingSlots)).filter(Boolean)
        return media.importPaths({ ...context, paths })
      },
      importDroppedFiles: async (input) => {
        const session = await auth.requireSession()
        requireOwnedConversation(input.conversationId, session.user.id)
        return media.importPaths(input)
      },
      importClipboardImage: async (context) => {
        const session = await auth.requireSession()
        requireOwnedConversation(context.conversationId, session.user.id)
        const image = options.readClipboardImage()
        return image ? media.importClipboardImage({ ...context, ...image }) : []
      },
      removeDraft: async ({ conversationId, assetId }) => {
        const session = await auth.requireSession()
        requireOwnedConversation(conversationId, session.user.id)
        return media.removeDraft(assetId, conversationId)
      },
      saveCopy: async (assetId) => {
        const session = await auth.requireSession()
        const record = database.mediaAssets.get(assetId)
        if (record) requireOwnedConversation(record.conversationId, session.user.id)
        const asset = await media.resolveReadyAsset(assetId)
        const destination = await options.chooseMediaSavePath(asset.name)
        if (destination) await copyFile(asset.absolutePath, destination)
      },
      reveal: async (assetId) => {
        const session = await auth.requireSession()
        const record = database.mediaAssets.get(assetId)
        if (record) requireOwnedConversation(record.conversationId, session.user.id)
        const asset = await media.resolveReadyAsset(assetId)
        options.revealPath(asset.absolutePath)
      },
      pauseVideoJob: async (jobId) => {
        const session = await auth.requireSession()
        const job = database.mediaGenerationJobs.get(jobId)
        if (!job) throw failure('NOT_FOUND')
        requireOwnedConversation(job.conversationId, session.user.id)
        return videoJobs.pause(jobId)
      },
      resumeVideoJob: async (jobId) => {
        const session = await auth.requireSession()
        const job = database.mediaGenerationJobs.get(jobId)
        if (!job) throw failure('NOT_FOUND')
        requireOwnedConversation(job.conversationId, session.user.id)
        return videoJobs.resume(jobId)
      },
    },
    workflows: {
      list: async (query?: WorkflowQuery) => {
        let workflows = await registry.list({ developerMode: settings.get().developerMode })
        if (query?.search) {
          const search = query.search.toLocaleLowerCase()
          workflows = workflows.filter((workflow) => `${workflow.name}\n${workflow.description}\n${workflow.id}`.toLocaleLowerCase().includes(search))
        }
        if (query?.category) workflows = workflows.filter((workflow) => workflow.category === query.category)
        if (query?.enabled !== undefined) workflows = workflows.filter((workflow) => workflow.enabled === query.enabled)
        if (query?.source) workflows = workflows.filter((workflow) => workflow.source === query.source)
        return workflows.map(summary)
      },
      get: async (id, version) => {
        const workflows = await registry.list({ developerMode: settings.get().developerMode })
        const workflow = version
          ? workflows.find((candidate) => candidate.id === id && candidate.version === version)
          : workflows.find((candidate) => candidate.id === id)
        if (!workflow) throw failure('NOT_FOUND')
        return workflow
      },
      setEnabled: async (id, version, enabled) => {
        if (!database.installedWorkflows.get(id, version)) throw failure('NOT_FOUND')
        registry.setEnabled(id, version, enabled)
      },
      remove: (id, version) => maintenance.runExclusive(
        () => activeRequests.size > 0
          || activeExecutions.size > 0
          || agent.hasActiveRuns()
          || executions.hasActiveExecutions()
          || browser.hasActiveContexts(),
        () => projects.removeInstalled(id, version),
      ),
      installProject: async (projectId) => {
        const installed = await projects.install(projectId)
        const workflow = await registry.get(installed.workflowId, installed.version)
        if (!workflow) throw failure('INTERNAL_ERROR')
        return workflow
      },
    },
    developer: {
      listProjects: async () => Promise.all(database.workflowProjects.list().map((project) => developerProject(project))),
      createProject: async (name) => developerProject(await projects.create(options.paths.projects, newManifest(name))),
      registerProject: async () => {
        const path = await options.chooseProjectDirectory()
        return path ? developerProject(projects.register(path)) : null
      },
      readFile: (projectId, relativePath) => projects.readFile(projectId, relativePath),
      writeFile: (projectId, relativePath, content) => projects.write(projectId, relativePath, content),
      createEntry: async (projectId, parentPath, name, kind) => {
        await projects.createEntry(projectId, parentPath, name, kind)
        const project = database.workflowProjects.get(projectId)
        if (!project) throw failure('NOT_FOUND')
        return developerProject(project)
      },
      renameEntry: async (projectId, relativePath, name) => {
        await projects.renameEntry(projectId, relativePath, name)
        const project = database.workflowProjects.get(projectId)
        if (!project) throw failure('NOT_FOUND')
        return developerProject(project)
      },
      deleteEntry: async (projectId, relativePath) => {
        await projects.deleteEntry(projectId, relativePath)
        const project = database.workflowProjects.get(projectId)
        if (!project) throw failure('NOT_FOUND')
        return developerProject(project)
      },
      build: async (projectId) => developerProject(await projects.build(projectId)),
      validate: (projectId) => projects.validate(projectId),
      run: async ({ projectId, input }) => {
        const releaseStart = maintenance.beginStart()
        try {
          const session = await auth.requireSession()
          const built = await projects.build(projectId)
          const manifest = built.manifest as WorkflowManifest
          try {
            const inputValidation = validateWorkflowInput(manifest.inputSchema, input)
            if (!inputValidation.valid) return { validationError: inputValidation.message }
          } catch (error) {
            if (typeof error === 'object' && error !== null && 'code' in error) throw error
            throw failure('INVALID_INPUT')
          }
          const workflow = await registry.getDevelopmentProject(projectId)
          if (!workflow) throw failure('WORKFLOW_INTEGRITY_FAILED')
          const started = await executions.start({
            userId: session.user.id,
            workflowId: manifest.id,
            workflowVersion: manifest.version,
            input,
            sourceSelector: sourceSelectorVault.create(workflow),
          })
          void started.finished.catch(() => undefined)
          return { executionId: started.id }
        } finally {
          releaseStart()
        }
      },
    },
    executions: {
      list: async (query?: ExecutionQuery) => {
        let records = database.executions.list()
        if (query?.status) records = records.filter((execution) => execution.status === query.status)
        if (query?.workflowId) records = records.filter((execution) => execution.workflowId === query.workflowId)
        if (query?.search) records = records.filter((execution) => `${execution.id}\n${execution.workflowId}`.toLocaleLowerCase().includes(query.search!.toLocaleLowerCase()))
        if (query?.from) records = records.filter((execution) => execution.createdAt >= Date.parse(query.from!))
        if (query?.to) records = records.filter((execution) => execution.createdAt <= Date.parse(query.to!))
        return records.map(executionSummary)
      },
      get: async (executionId) => {
        const execution = database.executions.get(executionId)
        if (!execution) throw failure('NOT_FOUND')
        const result: ExecutionDetail = {
          ...executionSummary(execution),
          input: execution.input,
          ...(execution.result === undefined ? {} : { output: execution.result }),
          ...(execution.errorCode ? { error: { code: execution.errorCode, message: toSafeAppError({ code: execution.errorCode }).message } } : {}),
          steps: database.executionSteps.list(executionId).map((step) => ({
            id: step.id,
            label: step.name,
            status: step.status as 'running' | 'completed' | 'failed',
            ...(iso(step.startedAt) ? { startedAt: iso(step.startedAt) } : {}),
            ...(iso(step.endedAt) ? { finishedAt: iso(step.endedAt) } : {}),
          })),
          logs: database.executionLogs.list(executionId).map((log) => ({
            id: log.id,
            level: log.level as 'debug' | 'info' | 'warn' | 'error',
            message: log.message,
            createdAt: new Date(log.createdAt).toISOString(),
          })),
        }
        return result
      },
      decide: async (decision) => {
        let result
        try {
          result = await agent.resumeApproval(decision)
        } catch (error) {
          recordFailure(error, 'background-chat')
          throw error
        }
        if (result.error?.code === 'CONFLICT') await executions.decide(decision)
      },
      cancel: async (executionId) => {
        const cancelledAgent = await agent.cancelExecution(executionId)
        if (!cancelledAgent) await executions.cancel(executionId)
        await browser.closeExecution(executionId)
      },
    },
    permissions: {
      listGrants: async () => database.permissionGrants.list().map((grant): PermissionGrant => ({
        id: grant.id,
        workflowId: grant.workflowId,
        workflowVersion: grant.workflowVersion,
        capability: grant.capability as PermissionGrant['capability'],
        scope: grant.scope as PermissionGrant['scope'],
        createdAt: new Date(grant.createdAt).toISOString(),
      })),
      revoke: async (grantId) => {
        if (!database.permissionGrants.list().some((grant) => grant.id === grantId)) throw failure('NOT_FOUND')
        policy.revoke(grantId)
      },
    },
    settings: {
      get: async () => settings.get(),
      update: (patch) => {
        const transaction = settingsUpdateTail.then(async () => {
          const previous = settings.get()
          const candidate = settings.preview(patch)
          const commit = () => {
            const committed = settings.commit(candidate)
            if (committed.theme !== previous.theme) options.applyTheme?.(committed.theme)
            return committed
          }
          if (JSON.stringify(previous.proxy) === JSON.stringify(candidate.proxy)) {
            return commit()
          }
          await options.networkProxy.transition(candidate.proxy)
          try {
            return commit()
          } catch {
            await options.networkProxy.transitionOrFailClosed(previous.proxy)
            throw failure('INTERNAL_ERROR')
          }
        })
        settingsUpdateTail = transaction.then(() => undefined, () => undefined)
        return transaction
      },
      saveProviderApiKey: async (provider, apiKey) => {
        await secretStore.set(credentialKeyForProvider(provider), apiKey)
        providerCredentialEpoch.set(provider, (providerCredentialEpoch.get(provider) ?? 0) + 1)
        modelCatalog.delete(provider)
        return { provider, configured: true, validation: 'unchecked' as const }
      },
      clearProviderApiKey: async (provider) => {
        secretStore.delete(credentialKeyForProvider(provider))
        providerCredentialEpoch.set(provider, (providerCredentialEpoch.get(provider) ?? 0) + 1)
        modelCatalog.delete(provider)
      },
      validateProviderCredential: credentialStatus,
      listProviderModels: (provider, refresh = false) => getModelCatalog(provider, refresh),
      getTokenUsage: async () => {
        const session = await auth.requireSession()
        const now = new Date()
        return createTokenUsageSnapshot(
          now,
          session.user.id,
          (query) => database.chatRuns.summarizeTokenUsage(query),
          (query) => database.providerUsage.summarize(query),
        )
      },
      clearLocalData: async (scope) => {
        await maintenance.runExclusive(
          () => activeRequests.size > 0
            || activeChatWork.size > 0
            || activeExecutions.size > 0
            || agent.hasActiveRuns()
            || mediaGeneration.hasActiveRuns()
            || database.mediaGenerationJobs.listActive().length > 0
            || executions.hasActiveExecutions()
            || browser.hasActiveContexts(),
          async () => {
            if (scope === 'conversations' || scope === 'all') {
              await mediaLifecycle.clearConversations()
            }
            if (scope === 'executions' || scope === 'all') {
              database.clearLocalData('executions')
            }
          },
        )
      },
    },
    system: {
      openExternal: async (url) => {
        const parsed = openExternalRequestSchema.safeParse({ url })
        if (!parsed.success) throw failure('INVALID_INPUT')
        await options.openExternal(parsed.data.url)
      },
      getAppInfo: async () => options.appInfo ?? { version: '0.1.0', platform: process.platform === 'win32' ? 'win32' : 'darwin' },
    },
  }

  let closePromise: Promise<void> | undefined
  return {
    services,
    mediaAssets: {
      resolveReadyAsset: async (assetId: string) => {
        const session = await auth.requireSession()
        const record = database.mediaAssets.get(assetId)
        if (record) requireOwnedConversation(record.conversationId, session.user.id)
        return media.resolveReadyAsset(assetId)
      },
    },
    recover: async () => {
      if (closePromise) throw failure('CONFLICT')
      await options.networkProxy.initialize(settings.get().proxy)
      await mediaLifecycle.recover()
      database.recoverInterrupted()
      providerUsageReconciliationLoop.start()
      await removeInterruptedRuntimeDirectories(options.paths.temporary)
      await projects.recoverRemovalJournals()
      await videoJobs.recover()
    },
    close: () => {
      if (closePromise) return closePromise
      closePromise = (async () => {
        acceptingWork = false
        const capture = async (
          source: ApplicationFailureSource,
          operation: () => void | Promise<void>,
        ): Promise<void> => {
          try { await Promise.resolve().then(operation) } catch (error) { recordFailure(error, source) }
        }
        const admittedStarts = Promise.resolve().then(() => maintenance.stopAndDrain())
        const reconciliationStopped = Promise.resolve()
          .then(() => providerUsageReconciliationLoop.stop())
          .catch((error: unknown) => { recordFailure(error, 'reconciliation-stop') })
        await capture('video-stop', () => videoJobs.stop())
        await capture('admission-drain', () => admittedStarts)
        const cancellations = [...activeRequests].flatMap((requestId) => [
          { source: 'agent-cancel' as const, operation: () => agent.cancel(requestId) },
          { source: 'media-cancel' as const, operation: () => mediaGeneration.cancel(requestId) },
        ])
        const cancellationResults = await Promise.allSettled(cancellations.map(({ operation }) => (
          Promise.resolve().then(operation)
        )))
        cancellationResults.forEach((result, index) => {
          if (result.status === 'rejected') recordFailure(result.reason, cancellations[index]!.source)
        })
        await capture('chat-drain', async () => {
          const results = await Promise.allSettled([...activeChatWork.values()].map((work) => work.promise))
          for (const result of results) if (result.status === 'rejected') {
            recordFailure(result.reason, 'chat-drain')
          }
        })
        await capture('execution-shutdown', () => executions.shutdown())
        await reconciliationStopped
        await capture('database-close', () => { database.close() })
        const terminalFailure = failureRecorder.select()
        if (terminalFailure !== undefined) throw terminalFailure.error
      })()
      return closePromise
    },
  }
}
