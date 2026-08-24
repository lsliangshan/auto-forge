import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  accountDataPreferencesDefaults,
  accountDataPreferencesRecordSchema,
  accountDataPreferencesSchema,
  byokUsageEventSchema,
  chatBlockSchema,
  conversationGenerationPreferencesSchema,
  legacyImportRequestSchema,
  openExternalRequestSchema,
  privacyConsentSchema,
  remoteUsageSnapshotSchema,
  toSafeAppError,
  type AppError,
  type AppSettings,
  type AccountDataPreferences,
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
  type SyncMutation,
} from '@autoforge/shared'
import type { WorkflowManifest } from '@autoforge/workflow-schema'
import {
  AgentOrchestrator,
  createAgentPersistence,
  type AgentRunResult,
} from './agent/agent-orchestrator.js'
import { BrowserContinuationCatalog } from './agent/browser-continuation-catalog.js'
import { BrowserContinuationToolExecutor } from './agent/browser-continuation-tool-executor.js'
import type { AuthService } from './auth/auth-service.js'
import { createCloudBaseClientPorts, readCloudBaseAuthConfig } from './auth/cloudbase-auth-port.js'
import { CloudBaseAuthService } from './auth/cloudbase-auth-service.js'
import { CloudBaseRoleService, type BusinessRoleService } from './auth/cloudbase-role-service.js'
import { BrowserCapabilityService, PolicyEngineBrowserAuthorization } from './browser/browser-capability.js'
import { BrowserContinuationRegistry } from './browser/browser-continuation-registry.js'
import { BrowserLoginWaitCoordinator } from './browser/browser-login-wait-coordinator.js'
import { BrowserManualResumeCoordinator } from './browser/browser-manual-resume-coordinator.js'
import { BrowserPageInspector } from './browser/browser-page-inspector.js'
import { EncryptedBrowserSessionStorageStore } from './browser/browser-session-storage-store.js'
import type { ApplicationBrowserWorkspacePort } from './browser/electron-browser-workspace.js'
import { DeepSeekProvider } from './chat/deepseek-provider.js'
import { createConversationContextManager } from './chat/conversation-context.js'
import { ConversationTitleService } from './chat/conversation-title-service.js'
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
import { UserDataStoreManager, type UserDataStore } from './database/user-data-client.js'
import { CloudBaseUserDataPort } from './cloud/cloudbase-user-data-port.js'
import { UserDataSyncEngine } from './sync/user-data-sync-engine.js'
import { LegacyUserDataImporter } from './sync/legacy-user-data-import.js'
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
import { WorkflowProjectService, type WorkflowProjectServiceOptions } from './workflows/project-service.js'
import { WorkflowRegistry } from './workflows/registry.js'
import {
  browserPermissionMatrix,
  canonicalJson,
  workflowSecurityFingerprint,
} from './workflows/workflow-security-fingerprint.js'
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
  | 'continuation-shutdown'
  | 'browser-shutdown'
  | 'sync-pause'
  | 'user-cache-close'
  | 'database-close'

const CLOUD_SYNC_DOCUMENT_VERSION = 'cloud-sync-2026-08'

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
  'continuation-shutdown': 80,
  'browser-shutdown': 90,
  'sync-pause': 95,
  'user-cache-close': 96,
  'database-close': 100,
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
  userDataStores?: UserDataStoreManager
  userDataSyncPort?: Pick<CloudBaseUserDataPort, 'call'>
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
  browserWorkspace: ApplicationBrowserWorkspacePort
  applyTheme?(theme: AppSettings['theme']): void
  /** @internal Test-only observation hook for the Main-owned Agent instance. */
  inspectAgent?(agent: Pick<AgentOrchestrator, 'ownsExecution' | 'hasActiveRuns'>): void
  /** @internal Test-only hooks for deterministic project mutation races. */
  projectServiceOptions?: WorkflowProjectServiceOptions
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

class UserDataAdmissionGate {
  private closed = false
  private stopped = false
  private active = 0
  private readonly drainWaiters = new Set<() => void>()

  private resolveDrainWaiters(): void {
    if (this.active !== 0) return
    for (const resolve of this.drainWaiters) resolve()
    this.drainWaiters.clear()
  }

  acceptsNewWork(): boolean {
    return !this.closed && !this.stopped
  }

  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.closed || this.stopped) throw failure('CONFLICT')
    this.active += 1
    try {
      return await operation()
    } finally {
      this.active -= 1
      this.resolveDrainWaiters()
    }
  }

  async transition<T>(operation: (waitForActive: () => Promise<void>) => Promise<T>): Promise<T> {
    if (this.closed || this.stopped) throw failure('CONFLICT')
    this.closed = true
    try {
      return await operation(async () => {
        if (this.active === 0) return
        await new Promise<void>((resolve) => { this.drainWaiters.add(resolve) })
      })
    } finally {
      this.closed = false
    }
  }

  async stopAndDrain(): Promise<void> {
    this.stopped = true
    this.closed = true
    if (this.active === 0) return
    await new Promise<void>((resolve) => { this.drainWaiters.add(resolve) })
  }
}

function iso(timestamp: number | undefined): string | undefined {
  return timestamp === undefined ? undefined : new Date(timestamp).toISOString()
}

function timeZoneParts(date: Date, timeZone: string): Record<string, number> {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).filter(({ type }) => type !== 'literal')
    .map(({ type, value }) => [type, Number(value)]))
}

function startOfMonthInTimeZone(now: Date, timeZone: string): Date {
  const current = timeZoneParts(now, timeZone)
  const localMidnight = Date.UTC(current.year!, current.month! - 1, 1)
  let instant = localMidnight
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const represented = timeZoneParts(new Date(instant), timeZone)
    const offset = Date.UTC(
      represented.year!, represented.month! - 1, represented.day!,
      represented.hour!, represented.minute!, represented.second!,
    ) - instant
    instant = localMidnight - offset
  }
  return new Date(instant)
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
  options.browserWorkspace.setSessionStorageStore?.(
    new EncryptedBrowserSessionStorageStore(secretStore),
  )
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
  const userDataStores = options.userDataStores
    ?? new UserDataStoreManager(join(options.paths.data, 'user-caches'))
  const userDataSyncPort = options.userDataSyncPort
    ?? (cloudBasePorts
      ? new CloudBaseUserDataPort(cloudBasePorts.functions)
      : { call: async () => { throw failure('SERVICE_UNAVAILABLE') } })
  let notifyConversationChanges: (conversationIds: readonly string[]) => void = () => undefined
  const userDataSync = new UserDataSyncEngine(userDataSyncPort, userDataStores, {
    onConversationChanged: (conversationIds) => { notifyConversationChanges(conversationIds) },
  })
  const legacyUserDataImporter = new LegacyUserDataImporter(database, userDataSync)
  const storedDeviceId = database.appSettings.get('user-data.device-id.v1')?.value
  const deviceId = typeof storedDeviceId === 'string'
    && storedDeviceId.length > 0
    && storedDeviceId.length <= 128
    && storedDeviceId.trim() === storedDeviceId
    && !storedDeviceId.includes('\0')
    ? storedDeviceId
    : randomUUID()
  if (deviceId !== storedDeviceId) database.appSettings.set('user-data.device-id.v1', deviceId)
  let boundUserId: string | undefined
  let runtimeRecovered = false
  let userDataLifecycleTail = Promise.resolve()
  let activateUserReconciliation: (recoverInterrupted: boolean) => void = () => undefined
  let pauseUserReconciliation = async (): Promise<void> => undefined
  let activateVideoJobs: (recoverInterrupted: boolean) => Promise<void> = async () => undefined
  let pauseVideoJobs = async (): Promise<void> => undefined
  const bindUserData = (session: AuthSession): Promise<void> => {
    const operation = userDataLifecycleTail.then(async () => {
      if (boundUserId === session.user.id && userDataStores.current()) {
        activateUserReconciliation(runtimeRecovered)
        await activateVideoJobs(runtimeRecovered)
        return
      }
      await userDataSync.start(session.user.id, deviceId)
      boundUserId = session.user.id
      await userDataSync.pull()
      activateUserReconciliation(runtimeRecovered)
      await activateVideoJobs(runtimeRecovered)
    })
    userDataLifecycleTail = operation.catch(() => undefined)
    return operation
  }
  const pauseUserData = (): Promise<void> => {
    const operation = userDataLifecycleTail.then(async () => {
      await pauseVideoJobs()
      await pauseUserReconciliation()
      await userDataSync.pause()
      userDataStores.close()
      boundUserId = undefined
    })
    userDataLifecycleTail = operation.catch(() => undefined)
    return operation
  }
  const currentUserData = (): UserDataStore => {
    const current = userDataStores.current()
    if (!current) throw failure('AUTH_REQUIRED')
    return current
  }
  const requireAuthenticatedSession = async (): Promise<AuthSession> => {
    const session = await auth.requireSession()
    await bindUserData(session)
    return session
  }
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
  const userDataAdmission = new UserDataAdmissionGate()
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
  const queueUserDataFlush = (): void => {
    void userDataSync.flush().catch(() => undefined)
  }
  const userRepository = <Key extends keyof UserDataStore>(key: Key): UserDataStore[Key] => (
    new Proxy({}, {
      get(_target, property) {
        const repository = currentUserData()[key] as object
        const value = Reflect.get(repository, property)
        return typeof value === 'function' ? value.bind(repository) : value
      },
    }) as UserDataStore[Key]
  )
  const cachedMessages = userRepository('messages')
  const cachedConversations = userRepository('conversations')
  const chatConversations = new Proxy(cachedConversations, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (property !== 'completeTitleGeneration') return value
      return (...args: unknown[]) => {
        const result = (value as (...parameters: unknown[]) => unknown)(...args)
        if (result !== undefined) queueUserDataFlush()
        return result
      }
    },
  }) as AppRepositories['conversations']
  const chatMessages = new Proxy(cachedMessages, {
    get(target, property, receiver) {
      if (property === 'insertWithAssets') {
        return (value: Parameters<AppRepositories['messages']['insertWithAssets']>[0], assetIds: string[]) => {
          const store = currentUserData()
          const summary = store.conversations.getSummary(value.conversationId)
          if (!summary) throw failure('NOT_FOUND')
          const occurredAt = new Date(value.createdAt).toISOString()
          const mutation: SyncMutation = {
            id: randomUUID(), kind: 'message.append', entityId: value.id,
            baseRevision: summary.revision, occurredAt,
            payload: {
              id: value.id, conversationId: value.conversationId,
              role: value.role === 'user' ? 'user' : 'assistant',
              blocks: chatBlockSchema.array().parse(value.blocks),
              ...(value.executionId === undefined ? {} : { executionId: value.executionId }),
              createdAt: occurredAt,
            },
          }
          store.outbox.recordWithMessage(mutation, assetIds)
          queueUserDataFlush()
          const stored = store.messages.get(value.id)
          if (!stored) throw failure('INTERNAL_ERROR')
          return stored
        }
      }
      return Reflect.get(target, property, receiver)
    },
  }) as AppRepositories['messages']
  const cachedChatRuns = userRepository('chatRuns')
  const chatRuns = new Proxy(cachedChatRuns, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (property !== 'startMediaGeneration' && property !== 'finalizeWithMessage') return value
      return (...args: unknown[]) => {
        const result = (value as (...parameters: unknown[]) => unknown)(...args)
        queueUserDataFlush()
        return result
      }
    },
  }) as AppRepositories['chatRuns']
  const cachedProviderUsage = userRepository('providerUsage')
  const providerUsage = new Proxy(cachedProviderUsage, {
    get(target, property, receiver) {
      if (property === 'recordByokUsage') {
        return (input: unknown) => {
          const event = byokUsageEventSchema.parse(input)
          const store = currentUserData()
          store.outbox.record({
            id: event.id,
            kind: 'usage.record',
            entityId: event.id,
            baseRevision: 0,
            occurredAt: event.occurredAt,
            payload: event,
          })
          queueUserDataFlush()
        }
      }
      return Reflect.get(target, property, receiver)
    },
  }) as AppRepositories['providerUsage']
  const chatDatabase: AppRepositories = {
    ...database,
    conversations: chatConversations,
    messages: chatMessages,
    conversationContexts: userRepository('conversationContexts'),
    mediaAssets: userRepository('mediaAssets'),
    mediaGenerationJobs: userRepository('mediaGenerationJobs'),
    chatRuns,
    providerUsage,
  }
  const providerUsageReconciler = new ProviderUsageReconciler({
    providerUsage: chatDatabase.providerUsage,
    providers: providerRegistry,
  })
  const projects = new WorkflowProjectService(database, options.paths.installations, options.projectServiceOptions)
  const registry = new WorkflowRegistry(database, projects)
  const media = createMediaAssetService({ database: chatDatabase, mediaRoot: join(options.paths.data, 'media') })
  const enqueueConversationDelete = (conversationId: string): void => {
    const store = currentUserData()
    const summary = store.conversations.getSummary(conversationId)
    if (!summary) throw failure('NOT_FOUND')
    store.outbox.recordWithConversation({
      id: randomUUID(), kind: 'conversation.delete', entityId: conversationId,
      baseRevision: summary.revision, payload: {}, occurredAt: new Date().toISOString(),
    })
    queueUserDataFlush()
  }
  const mediaLifecycle = new MediaLifecycle({
    database: {
      ...chatDatabase,
      conversations: {
        get: (id) => chatDatabase.conversations.get(id),
        list: () => chatDatabase.conversations.list(),
        delete: enqueueConversationDelete,
      },
      clearConversations: () => {
        for (const conversation of currentUserData().conversations.list()) {
          if (currentUserData().conversations.getSummary(conversation.id)) {
            enqueueConversationDelete(conversation.id)
          }
        }
      },
    },
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
  const developmentRebuilds = new Map<string, number>()
  const browserContinuations = new BrowserContinuationRegistry({
    repository: database.browserTabBindings,
    workspace: options.browserWorkspace,
    isEligible: async (binding) => {
      let workflow: WorkflowDetail | undefined
      if (binding.source === 'installed') {
        const integrity = await registry.verifyIntegrity(binding.workflowId, binding.workflowVersion)
        if (!integrity.valid || integrity.disabled) return false
        workflow = await registry.get(binding.workflowId, binding.workflowVersion, { developerMode: false })
      } else {
        if (!settings.get().developerMode || !binding.buildHash) return false
        const matches = (await Promise.all(database.workflowProjects.list().map(async (project) => {
          const manifest = project.manifest as Partial<WorkflowManifest> | undefined
          if (developmentRebuilds.has(project.id)
            || project.status !== 'ready'
            || project.buildHash !== binding.buildHash
            || manifest?.id !== binding.workflowId
            || manifest.version !== binding.workflowVersion) return undefined
          return registry.getDevelopmentProject(project.id)
        }))).filter((candidate): candidate is WorkflowDetail => candidate !== undefined)
        if (matches.length !== 1) return false
        workflow = matches[0]
      }
      if (!workflow) return false
      const exactRuntimeIdentity = binding.source === 'installed'
        ? workflow.source === 'installed'
          && workflow.runtimeIdentity.source === 'installed'
        : workflow.source === 'development'
          && workflow.runtimeIdentity.source === 'development'
          && workflow.runtimeIdentity.buildHash === binding.buildHash
      return exactRuntimeIdentity
        && workflow.enabled
        && workflow.integrity === 'valid'
        && workflow.id === binding.workflowId
        && workflow.version === binding.workflowVersion
        && workflowSecurityFingerprint(workflow) === binding.securityFingerprint
        && canonicalJson(browserPermissionMatrix(workflow)) === canonicalJson(binding.permissionMatrix)
    },
    onTakeOver: async ({ binding, runId }) => {
      const session = await auth.requireSession()
      const run = chatDatabase.chatRuns.get(runId)
      const conversation = chatDatabase.conversations.get(binding.conversationId)
      if (!run
        || !conversation
        || session.user.id !== binding.userId
        || conversation.userId !== binding.userId
        || run.userId !== binding.userId
        || run.conversationId !== binding.conversationId) throw failure('NOT_FOUND')
      if (!await agent.takeOverBrowser(run.requestId, binding.bindingId, runId)) throw failure('NOT_FOUND')
    },
  })
  const finishDevelopmentRebuild = (projectId: string): void => {
    const remaining = (developmentRebuilds.get(projectId) ?? 1) - 1
    if (remaining > 0) developmentRebuilds.set(projectId, remaining)
    else developmentRebuilds.delete(projectId)
  }
  const beginDevelopmentRebuild = async (projectId: string): Promise<void> => {
    developmentRebuilds.set(projectId, (developmentRebuilds.get(projectId) ?? 0) + 1)
    const previous = database.workflowProjects.get(projectId)
    const manifest = previous?.manifest as Partial<WorkflowManifest> | undefined
    try {
      if (previous?.buildHash && manifest?.id && manifest.version) {
        await browserContinuations.revokeWorkflow({
          workflowId: manifest.id,
          workflowVersion: manifest.version,
          source: 'development',
          buildHash: previous.buildHash,
        }, 'WORKFLOW_CHANGED')
      }
    } catch (error) {
      finishDevelopmentRebuild(projectId)
      throw error
    }
  }
  const browser = new BrowserCapabilityService({
    authorization: new PolicyEngineBrowserAuthorization(policy),
    workspace: options.browserWorkspace,
    currentUserId: async () => (await auth.getSession())?.user.id,
    continuationRegistry: browserContinuations,
  })
  const browserInspector = new BrowserPageInspector(options.browserWorkspace)
  const browserLoginWait = new BrowserLoginWaitCoordinator({
    onPageInvalidated: (listener) => options.browserWorkspace.onPageInvalidated(listener),
  })
  const browserManualWait = new BrowserManualResumeCoordinator({
    onActivity: (listener) => options.browserWorkspace.onContinuationActivity(listener),
  })
  let isBrowserRunActive: (runId: string) => boolean = () => false
  const browserContinuationExecutor = new BrowserContinuationToolExecutor({
    registry: browserContinuations,
    inspector: browserInspector,
    workspace: options.browserWorkspace,
    loginWait: browserLoginWait,
    manualWait: browserManualWait,
    audits: database.browserActionAudits,
    isRunActive: (runId) => isBrowserRunActive(runId),
  })
  const browserContinuationCatalog = new BrowserContinuationCatalog({
    registry: browserContinuations,
    describe: async (binding) => {
      const description = await options.browserWorkspace.describeContinuation(binding.tabId)
      if (!description) return undefined
      let workflowLabel = binding.workflowId
      if (binding.source === 'installed') {
        workflowLabel = (await registry.get(binding.workflowId, binding.workflowVersion, {
          developerMode: false,
        }))?.name ?? workflowLabel
      } else {
        const candidates = await Promise.all(database.workflowProjects.list().map((project) => (
          registry.getDevelopmentProject(project.id)
        )))
        workflowLabel = candidates.find((candidate) => candidate?.id === binding.workflowId
          && candidate.version === binding.workflowVersion
          && candidate.runtimeIdentity.source === 'development'
          && candidate.runtimeIdentity.buildHash === binding.buildHash)?.name ?? workflowLabel
      }
      return { workflowLabel, ...description }
    },
  })
  const sourceResolver = createWorkflowExecutionSourceResolver(sourceSelectorVault, {
    repositories: database,
    registry,
  })

  const activeExecutions = new Set<string>()
  const activeRequests = new Set<string>()
  const activeChatAdmissions = new Set<Promise<void>>()
  const activeChatWork = new Map<string, {
    conversationId: string
    promise: Promise<void>
  }>()
  const activeConversationTitleWork = new Map<string, {
    conversationId: string
    controller: AbortController
    promise: Promise<void>
  }>()
  const conversationTitleContexts = new Map<string, {
    conversationId: string
    userId: string
    providerSnapshot: ModelProviderSnapshot
    providerCredentialEpoch: number
    model?: string
  }>()
  let acceptingWork = true
  const failureRecorder = createApplicationFailureRecorder(() => { acceptingWork = false })
  const recordFailure = failureRecorder.record
  const createReconciliationLoop = () => createProviderUsageReconciliationLoop(
    providerUsageReconciler,
    (error) => { recordFailure(error, 'reconciliation-stop') },
  )
  let providerUsageReconciliationLoop = createReconciliationLoop()
  let userReconciliationActive = false
  let userRecoveryStarted = false
  activateUserReconciliation = (recoverInterrupted) => {
    if (!userReconciliationActive) {
      providerUsageReconciliationLoop = createReconciliationLoop()
      userReconciliationActive = true
    }
    if (recoverInterrupted && !userRecoveryStarted) {
      userRecoveryStarted = true
      providerUsageReconciliationLoop.start()
    }
  }
  pauseUserReconciliation = async () => {
    if (!userReconciliationActive) return
    userReconciliationActive = false
    userRecoveryStarted = false
    await providerUsageReconciliationLoop.stop()
  }
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
  const conversationTitles = new ConversationTitleService({
    repositories: chatDatabase,
    emit: (event) => emitChat(event),
    id: randomUUID,
    now: Date.now,
  })
  const emitChat = (event: ChatEvent) => {
    if (event.type === 'status' && ['completed', 'cancelled', 'failed'].includes(event.status)) {
      activeRequests.delete(event.requestId)
      if (userReconciliationActive) providerUsageReconciliationLoop.notifyUsageEnded()
    }
    const ownerId = chatDatabase.conversations.get(event.conversationId)?.userId
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
    if (event.type === 'status' && ['completed', 'cancelled', 'failed'].includes(event.status)) {
      const context = conversationTitleContexts.get(event.requestId)
      conversationTitleContexts.delete(event.requestId)
      if (event.status !== 'completed') return
      const run = chatDatabase.chatRuns.getByRequestId(event.requestId)
      if (
        context
        && belongsToCurrentUser
        && context.conversationId === event.conversationId
        && context.userId === ownerId
        && run?.userId === context.userId
        && run.provider === context.providerSnapshot.providerId
        && (providerCredentialEpoch.get(run.provider) ?? 0) === context.providerCredentialEpoch
        && userDataAdmission.acceptsNewWork()
      ) {
        const controller = new AbortController()
        const promise = conversationTitles.generate({
          conversationId: event.conversationId,
          userId: context.userId,
          requestId: event.requestId,
          providerSnapshot: context.providerSnapshot,
          ...(context.model === undefined ? {} : { model: context.model }),
          signal: controller.signal,
        }).then(() => undefined).finally(() => {
          activeConversationTitleWork.delete(event.requestId)
        })
        activeConversationTitleWork.set(event.requestId, {
          conversationId: event.conversationId,
          controller,
          promise,
        })
      } else {
        chatDatabase.conversations.failPendingTitleGeneration(event.conversationId)
      }
    }
  }
  notifyConversationChanges = (conversationIds) => {
    for (const conversationId of conversationIds) {
      const conversation = currentUserData().conversations.getSummary(conversationId)
      if (conversation) {
        emitChat({ type: 'conversation_updated', conversationId, conversation })
      } else {
        emitChat({ type: 'conversation_removed', conversationId })
      }
    }
  }
  const conversationContext = createConversationContextManager(chatDatabase)
  const agent = new AgentOrchestrator({
    workflows: registry,
    persistence: createAgentPersistence(chatDatabase),
    history: conversationContext,
    policy,
    executions,
    createSourceSelector: sourceSelectorVault.create,
    inspectSource: sourceSelectorVault.inspect,
    resolveCurrentWorkflow: async (selector, id, version) => (
      (await sourceResolver.resolve(id, version, selector))?.workflow
    ),
    checkRemainingBudgets: ({ toolExecutions }) => (
      toolExecutions >= 5 ? 'TOOL_CALL_LIMIT' : undefined
    ),
    providerUsage: chatDatabase.providerUsage,
    emit: emitChat,
    developerMode: () => settings.get().developerMode,
    browserContinuation: {
      catalog: browserContinuationCatalog,
      executor: browserContinuationExecutor,
    },
  })
  isBrowserRunActive = (runId) => agent.ownsBrowserRun(runId)
  options.inspectAgent?.(agent)
  const persistence = createAgentPersistence(chatDatabase)
  const mediaGeneration = new MediaGenerationOrchestrator({
    providers: providerRegistry,
    persistence,
    media,
    downloader: new SafeMediaDownloader({
      transport: options.mediaTransport ?? new PinnedMediaTransport(),
      withTransportLease: options.networkProxy.withTransportLease.bind(options.networkProxy),
    }),
    providerUsage: chatDatabase.providerUsage,
    emit: emitChat,
  })
  const createVideoJobs = () => new VideoJobRunner({
    database: chatDatabase,
    providerUsage: chatDatabase.providerUsage,
    providers: providerRegistry,
    media,
    emit: emitChat,
    onBackgroundFailure: (error) => { recordFailure(error, 'video-background') },
    onMutationCommitted: () => { queueUserDataFlush() },
  })
  let videoJobs = createVideoJobs()
  activateVideoJobs = async (recoverInterrupted) => {
    if (recoverInterrupted) await videoJobs.recover()
  }
  pauseVideoJobs = async () => {
    try {
      await videoJobs.stop()
    } finally {
      videoJobs = createVideoJobs()
    }
  }

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
    const conversation = chatDatabase.conversations.get(conversationId)
    if (!conversation || conversation.userId !== userId) throw failure('NOT_FOUND')
    return conversation
  }

  const requireOwnedLiveBinding = (bindingId: string, userId: string) => {
    const live = browserContinuations.get(bindingId)
    const durable = database.browserTabBindings.get(bindingId)
    if (!live
      || !durable
      || durable.status !== 'active'
      || live.userId !== userId
      || durable.userId !== userId
      || durable.conversationId !== live.conversationId) throw failure('NOT_FOUND')
    requireOwnedConversation(live.conversationId, userId)
    return live
  }
  const requireOwnedBrowserRun = (requestId: string, conversationId: string, userId: string) => {
    const run = chatDatabase.chatRuns.getByRequestId(requestId)
    if (!run || run.userId !== userId || run.conversationId !== conversationId) throw failure('NOT_FOUND')
    return run
  }
  const takeOverOwnedBrowser = async (
    requestId: string,
    bindingId: string,
    userId: string,
  ): Promise<void> => {
    const binding = requireOwnedLiveBinding(bindingId, userId)
    const run = requireOwnedBrowserRun(requestId, binding.conversationId, userId)
    const lease = browserContinuations.currentLease(bindingId)
    if (!lease || lease.binding !== binding || lease.runId !== run.id) throw failure('NOT_FOUND')
    if (!await agent.takeOverBrowser(requestId, bindingId, run.id)) throw failure('NOT_FOUND')
  }
  const currentBrowserRequest = (bindingId: string, userId: string) => {
    const lease = browserContinuations.currentLease(bindingId)
    if (!lease || lease.binding.userId !== userId) throw failure('NOT_FOUND')
    const run = chatDatabase.chatRuns.get(lease.runId)
    if (!run || run.userId !== userId || run.conversationId !== lease.binding.conversationId) {
      throw failure('NOT_FOUND')
    }
    return { binding: lease.binding, run }
  }
  options.browserWorkspace.setContinuationCommandHandlers({
    stop: async (bindingId) => {
      const session = await auth.requireSession()
      const current = currentBrowserRequest(bindingId, session.user.id)
      await agent.cancel(current.run.requestId)
    },
    takeOver: async (bindingId) => {
      const session = await auth.requireSession()
      const current = currentBrowserRequest(bindingId, session.user.id)
      await takeOverOwnedBrowser(current.run.requestId, current.binding.bindingId, session.user.id)
    },
  })
  const cancelAgentRequestsForUser = async (userId: string): Promise<void> => {
    const requestIds = [...activeRequests].filter((requestId) => (
      chatDatabase.chatRuns.getByRequestId(requestId)?.userId === userId
    ))
    const results = await Promise.allSettled(requestIds.map((requestId) => agent.cancel(requestId)))
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
  }
  const resetBrowserIdentity = async (userId: string): Promise<void> => {
    const failures: unknown[] = []
    try { await cancelAgentRequestsForUser(userId) } catch (error) { failures.push(error) }
    try { await browserContinuations.revokeUser(userId, 'CANCELLED') } catch (error) { failures.push(error) }
    try { await browser.reset() } catch (error) { failures.push(error) }
    if (failures.length > 0) throw failures[0]
  }
  const beforeAuthIdentityChange = async (waitForActive: () => Promise<void>): Promise<void> => {
    const current = await auth.getSession()
    if (current) {
      await resetBrowserIdentity(current.user.id)
      const admissions = [...activeChatAdmissions]
      if (admissions.length > 0) {
        await Promise.all(admissions)
        await new Promise<void>((resolve) => { setImmediate(resolve) })
        await resetBrowserIdentity(current.user.id)
      }
      await Promise.all([...activeChatWork.values()].map(({ promise }) => promise))
      const titleWork = [...activeConversationTitleWork.values()]
      for (const work of titleWork) work.controller.abort()
      await Promise.all(titleWork.map(({ promise }) => promise))
      await waitForActive()
      await pauseUserData()
      return
    }
    await waitForActive()
  }
  const transitionIdentity = <T>(operation: () => Promise<T>): Promise<T> => (
    userDataAdmission.transition(async (waitForActive) => {
      try {
        await beforeAuthIdentityChange(waitForActive)
        return await operation()
      } catch (error) {
        const restored = await auth.getSession().catch(() => null)
        if (restored) await bindUserData(restored)
        else await pauseUserData()
        throw error
      }
    })
  )

  let settingsUpdateTail = Promise.resolve()
  const ungatedServices: DesktopIpcServices = {
    auth: {
      getSession: () => userDataAdmission.transition(async (waitForActive) => {
        try {
          await waitForActive()
          const session = await auth.getSession()
          if (session) await bindUserData(session)
          else await pauseUserData()
          return session
        } catch (error) {
          const restored = await auth.getSession().catch(() => null)
          if (restored) await bindUserData(restored)
          throw error
        }
      }),
      refreshAuthorization: () => userDataAdmission.run(async () => {
        const session = await auth.refreshAuthorization()
        await bindUserData(session)
        return session
      }),
      sendOtp: (input) => auth.sendOtp(input),
      verifyOtp: (input) => transitionIdentity(async () => {
        const session = await auth.verifyOtp(input)
        await bindUserData(session)
        return session
      }),
      cancelOtp: (challengeId) => auth.cancelOtp(challengeId),
      loginWithPassword: (input) => transitionIdentity(async () => {
        const session = await auth.loginWithPassword(input)
        await bindUserData(session)
        return session
      }),
      logout: () => transitionIdentity(() => auth.logout()),
      requireSession: () => userDataAdmission.run(requireAuthenticatedSession),
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
      listConversations: async (input) => {
        await requireAuthenticatedSession()
        const page = currentUserData().conversations.listPage(input)
        void userDataSync.pull().catch(() => undefined)
        return page
      },
      listMessages: async (input) => {
        const session = await requireAuthenticatedSession()
        requireOwnedConversation(input.conversationId, session.user.id)
        const page = currentUserData().messages.listPage(input)
        void userDataSync.pull().catch(() => undefined)
        return page
      },
      createConversation: async () => {
        await requireAuthenticatedSession()
        const store = currentUserData()
        if (store.account.getConsent('cloud_sync')?.documentVersion
          !== CLOUD_SYNC_DOCUMENT_VERSION) {
          throw failure('IMPORT_CONFIRMATION_REQUIRED')
        }
        const id = randomUUID()
        const occurredAt = new Date().toISOString()
        store.outbox.recordWithConversation({
          id: randomUUID(), kind: 'conversation.create', entityId: id, baseRevision: 0,
          occurredAt,
          payload: {
            title: '新会话', titleState: 'pending', createdAt: occurredAt,
            lastActivityAt: occurredAt, metadataUpdatedAt: occurredAt,
          },
        })
        queueUserDataFlush()
        const conversation = store.conversations.getSummary(id)
        if (!conversation) throw failure('INTERNAL_ERROR')
        return conversation
      },
      renameConversation: async (conversationId, title) => {
        const session = await requireAuthenticatedSession()
        requireOwnedConversation(conversationId, session.user.id)
        const store = currentUserData()
        const existing = store.conversations.getSummary(conversationId)
        if (!existing) throw failure('NOT_FOUND')
        const occurredAt = new Date().toISOString()
        store.outbox.recordWithConversation({
          id: randomUUID(), kind: 'conversation.rename', entityId: conversationId,
          baseRevision: existing.revision, occurredAt,
          payload: { title, titleState: 'user_named', metadataUpdatedAt: occurredAt },
        })
        queueUserDataFlush()
        const conversation = store.conversations.getSummary(conversationId)
        if (!conversation) throw failure('NOT_FOUND')
        return conversation
      },
      deleteConversation: async (conversationId) => {
        const session = await requireAuthenticatedSession()
        requireOwnedConversation(conversationId, session.user.id)
        return maintenance.runExclusive(
          () => [...activeChatWork.values()].some((work) => work.conversationId !== conversationId)
            || [...activeConversationTitleWork.values()].some(
              (work) => work.conversationId !== conversationId,
            )
            || mediaGeneration.hasActiveRuns()
            || chatDatabase.mediaGenerationJobs.listActive().length > 0
            || activeExecutions.size > 0
            || executions.hasActiveExecutions()
            || browser.hasActiveContexts(),
          async () => {
            const requests = [...activeChatWork.entries()]
              .filter(([, work]) => work.conversationId === conversationId)
            await Promise.all(requests.map(([requestId]) => agent.cancel(requestId)))
            await Promise.all(requests.map(([, work]) => work.promise))
            const titleRequests = [...activeConversationTitleWork.values()]
              .filter((work) => work.conversationId === conversationId)
            for (const work of titleRequests) work.controller.abort()
            await Promise.all(titleRequests.map((work) => work.promise))
            await browserContinuations.revokeConversation(conversationId, 'CANCELLED')
            await mediaLifecycle.deleteConversation(conversationId)
          },
        )
      },
      retrySync: async (conversationId) => {
        const session = await requireAuthenticatedSession()
        requireOwnedConversation(conversationId, session.user.id)
        await userDataSync.retry(conversationId)
      },
      send: async (input) => {
        const session = await auth.requireSession()
        const releaseStart = maintenance.beginStart()
        let finishAdmission!: () => void
        const admission = new Promise<void>((resolve) => { finishAdmission = resolve })
        activeChatAdmissions.add(admission)
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
          const titleModel = snapshot.defaultModels[providerSnapshot.providerId].text
          conversationTitleContexts.set(requestId, {
            conversationId: input.conversationId,
            userId: session.user.id,
            providerSnapshot,
            providerCredentialEpoch: credentialEpoch,
            ...(titleModel === undefined ? {} : { model: titleModel }),
          })
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
              conversationTitleContexts.delete(requestId)
              if (error instanceof ProviderUsageConsistencyError) {
                recordFailure(error, 'video-submit')
              }
              throw error
            }
          }
          return { requestId }
        } finally {
          releaseStart()
          activeChatAdmissions.delete(admission)
          finishAdmission()
        }
      },
      cancel: async (requestId) => {
        const session = await auth.requireSession()
        const conversationId = activeChatWork.get(requestId)?.conversationId
          ?? chatDatabase.chatRuns.getByRequestId(requestId)?.conversationId
        if (!conversationId) throw failure('NOT_FOUND')
        requireOwnedConversation(conversationId, session.user.id)
        await Promise.allSettled([
          agent.cancel(requestId),
          mediaGeneration.cancel(requestId),
        ])
      },
      takeOverBrowser: async (input) => {
        const session = await auth.requireSession()
        await takeOverOwnedBrowser(input.requestId, input.bindingId, session.user.id)
      },
      listBrowserAudit: async (bindingId) => {
        const session = await auth.requireSession()
        const binding = database.browserTabBindings.get(bindingId)
        if (!binding || binding.userId !== session.user.id) throw failure('NOT_FOUND')
        requireOwnedConversation(binding.conversationId, session.user.id)
        return database.browserActionAudits.list(bindingId).map((audit) => ({
          id: audit.id,
          bindingId: audit.bindingId,
          sequence: audit.sequence,
          origin: audit.origin,
          action: audit.action,
          targetSummary: audit.targetSummary,
          risk: audit.risk,
          outcome: audit.outcome,
          ...(audit.errorCode === undefined ? {} : { errorCode: audit.errorCode }),
          createdAt: audit.createdAt,
        }))
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
        const conversation = chatDatabase.conversations.updateGenerationPreferences(conversationId, normalized.data)
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
        const record = chatDatabase.mediaAssets.get(assetId)
        if (!record) throw failure('NOT_FOUND')
        requireOwnedConversation(record.conversationId, session.user.id)
        const asset = await media.resolveReadyAsset(assetId)
        const destination = await options.chooseMediaSavePath(asset.name)
        if (destination) await copyFile(asset.absolutePath, destination)
      },
      reveal: async (assetId) => {
        const session = await auth.requireSession()
        const record = chatDatabase.mediaAssets.get(assetId)
        if (!record) throw failure('NOT_FOUND')
        requireOwnedConversation(record.conversationId, session.user.id)
        const asset = await media.resolveReadyAsset(assetId)
        options.revealPath(asset.absolutePath)
      },
      pauseVideoJob: async (jobId) => {
        const session = await auth.requireSession()
        const job = chatDatabase.mediaGenerationJobs.get(jobId)
        if (!job) throw failure('NOT_FOUND')
        requireOwnedConversation(job.conversationId, session.user.id)
        return videoJobs.pause(jobId)
      },
      resumeVideoJob: async (jobId) => {
        const session = await auth.requireSession()
        const job = chatDatabase.mediaGenerationJobs.get(jobId)
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
        if (!enabled) {
          await browserContinuations.revokeWorkflow({
            workflowId: id, workflowVersion: version, source: 'installed',
          }, 'WORKFLOW_CHANGED')
        }
      },
      remove: (id, version) => maintenance.runExclusive(
        () => activeRequests.size > 0
          || activeExecutions.size > 0
          || agent.hasActiveRuns()
          || executions.hasActiveExecutions()
          || browser.hasActiveContexts(),
        async () => {
          await browserContinuations.revokeWorkflow({
            workflowId: id, workflowVersion: version, source: 'installed',
          }, 'WORKFLOW_CHANGED')
          await projects.removeInstalled(id, version)
        },
      ),
      installProject: async (projectId) => {
        const installed = await projects.install(projectId)
        await browserContinuations.revokeWorkflow({
          workflowId: installed.workflowId,
          workflowVersion: installed.version,
          source: 'installed',
        }, 'WORKFLOW_CHANGED')
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
      build: async (projectId) => {
        await beginDevelopmentRebuild(projectId)
        try {
          return developerProject(await projects.build(projectId))
        } finally {
          finishDevelopmentRebuild(projectId)
        }
      },
      validate: (projectId) => projects.validate(projectId),
      run: async ({ projectId, input }) => {
        const releaseStart = maintenance.beginStart()
        try {
          const session = await auth.requireSession()
          await beginDevelopmentRebuild(projectId)
          let built: WorkflowProject
          try {
            built = await projects.build(projectId)
          } finally {
            finishDevelopmentRebuild(projectId)
          }
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
        const agentOwned = agent.recognizesExecution(decision.executionId)
          || chatDatabase.messages.hasWorkflowApproval(decision.executionId)
        let result
        try {
          result = await agent.resumeApproval(decision)
        } catch (error) {
          recordFailure(error, 'background-chat')
          throw error
        }
        if (result.error && agentOwned) throw result.error
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
          const invalidate = async (committed: AppSettings) => {
            if (committed.developerMode === previous.developerMode) return
            try {
              await agent.onDeveloperModeChanged(committed.developerMode)
            } catch (error) {
              recordFailure(error, 'background-chat')
            }
            if (!committed.developerMode) {
              await browserContinuations.revokeDevelopment('WORKFLOW_CHANGED')
            }
          }
          if (JSON.stringify(previous.proxy) === JSON.stringify(candidate.proxy)) {
            const committed = commit()
            await invalidate(committed)
            return committed
          }
          await options.networkProxy.transition(candidate.proxy)
          let committed: AppSettings
          try {
            committed = commit()
          } catch {
            await options.networkProxy.transitionOrFailClosed(previous.proxy)
            throw failure('INTERNAL_ERROR')
          }
          await invalidate(committed)
          return committed
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
          (query) => chatDatabase.chatRuns.summarizeTokenUsage(query),
          (query) => chatDatabase.providerUsage.summarize(query),
        )
      },
      recordPrivacyConsent: async (input) => {
        await requireAuthenticatedSession()
        const consent = privacyConsentSchema.safeParse(input)
        if (!consent.success
          || consent.data.purpose !== 'cloud_sync'
          || consent.data.documentVersion !== CLOUD_SYNC_DOCUMENT_VERSION) {
          throw failure('INVALID_INPUT')
        }
        const store = currentUserData()
        if (JSON.stringify(store.account.getConsent('cloud_sync')) === JSON.stringify(consent.data)) return
        store.outbox.recordWithConsent({
          id: randomUUID(), kind: 'privacy.consent', entityId: consent.data.documentVersion,
          baseRevision: 0, occurredAt: consent.data.consentedAt, payload: consent.data,
        })
        queueUserDataFlush()
      },
      previewLegacyImport: async () => {
        const session = await requireAuthenticatedSession()
        return legacyUserDataImporter.preview(session.user.id)
      },
      importLegacyData: async (input) => {
        const session = await requireAuthenticatedSession()
        const confirmation = legacyImportRequestSchema.safeParse(input)
        const store = currentUserData()
        const storedCloudConsent = store.account.getConsent('cloud_sync')
        if (!confirmation.success
          || confirmation.data.cloudSyncConsent.documentVersion !== CLOUD_SYNC_DOCUMENT_VERSION
          || JSON.stringify(storedCloudConsent) !== JSON.stringify(confirmation.data.cloudSyncConsent)) {
          throw failure('IMPORT_CONFIRMATION_REQUIRED')
        }
        if (confirmation.data.includeUnowned) {
          const consent = confirmation.data.unownedImportConsent
          if (!consent) throw failure('IMPORT_CONFIRMATION_REQUIRED')
          if (JSON.stringify(store.account.getConsent('legacy_unowned_import'))
            !== JSON.stringify(consent)) {
            store.outbox.recordWithConsent({
              id: randomUUID(), kind: 'privacy.consent', entityId: consent.documentVersion,
              baseRevision: 0, occurredAt: consent.consentedAt, payload: consent,
            })
            await userDataSync.flush()
          }
        }
        const selectionFingerprint = legacyUserDataImporter.selectionFingerprint(
          session.user.id,
          confirmation.data.includeUnowned,
        )
        const batchId = store.account.resolveLegacyImportBatch({
          selectionFingerprint,
          includeUnowned: confirmation.data.includeUnowned,
          cloudConsentVersion: confirmation.data.cloudSyncConsent.documentVersion,
          ...(confirmation.data.unownedImportConsent ? {
            unownedConsentVersion: confirmation.data.unownedImportConsent.documentVersion,
          } : {}),
          candidateBatchId: `legacy-${randomUUID()}`,
        })
        const results = await legacyUserDataImporter.import(session.user.id, {
          ...confirmation.data,
          batchId,
        })
        await userDataSync.pull()
        const pullStatus = userDataSync.status()
        if (pullStatus.state !== 'idle') {
          throw failure('errorCode' in pullStatus ? pullStatus.errorCode ?? 'INTERNAL_ERROR' : 'INTERNAL_ERROR')
        }
        return results
      },
      getAccountDataPreferences: async (): Promise<AccountDataPreferences> => {
        await requireAuthenticatedSession()
        const store = currentUserData()
        let preferences = store.account.getPreferences()
        if (!preferences) {
          const response = await userDataSyncPort.call({ action: 'getUserDataPreferences' })
          if (!response.ok) throw failure(response.error.code)
          const parsed = accountDataPreferencesRecordSchema.safeParse(response.data)
          if (!parsed.success) throw failure('INTERNAL_ERROR')
          store.account.projectPreferences(parsed.data)
          preferences = parsed.data
        }
        return accountDataPreferencesSchema.parse({
          timezone: preferences.timezone,
          displayCurrency: preferences.displayCurrency,
        })
      },
      updateAccountDataPreferences: async (input) => {
        await requireAuthenticatedSession()
        const preferences = accountDataPreferencesSchema.safeParse(input)
        if (!preferences.success) throw failure('INVALID_INPUT')
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: preferences.data.timezone }).format()
        } catch {
          throw failure('INVALID_INPUT')
        }
        const store = currentUserData()
        const current = store.account.getPreferences()
        const occurredAt = new Date().toISOString()
        store.outbox.recordWithPreferences({
          id: randomUUID(), kind: 'preferences.update', entityId: 'account-preferences',
          baseRevision: current?.revision ?? 0, occurredAt, payload: preferences.data,
        })
        queueUserDataFlush()
        return preferences.data
      },
      getRemoteUsage: async () => {
        await requireAuthenticatedSession()
        const store = currentUserData()
        let storedPreferences = store.account.getPreferences()
        if (!storedPreferences) {
          const preferencesResponse = await userDataSyncPort.call({
            action: 'getUserDataPreferences',
          })
          if (!preferencesResponse.ok) throw failure(preferencesResponse.error.code)
          const parsed = accountDataPreferencesRecordSchema.safeParse(preferencesResponse.data)
          if (!parsed.success) throw failure('INTERNAL_ERROR')
          store.account.projectPreferences(parsed.data)
          storedPreferences = parsed.data
        }
        const preferences = storedPreferences
          ? accountDataPreferencesSchema.parse({
              timezone: storedPreferences.timezone,
              displayCurrency: storedPreferences.displayCurrency,
            })
          : accountDataPreferencesSchema.parse(accountDataPreferencesDefaults)
        const endedAt = new Date()
        const startedAt = startOfMonthInTimeZone(endedAt, preferences.timezone)
        const response = await userDataSyncPort.call({
          action: 'getUsageSnapshot',
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
        })
        if (!response.ok) throw failure(response.error.code)
        if (!('estimatedCostUsd' in response.data)) throw failure('INTERNAL_ERROR')
        const checkpoint = store.sync.getCheckpoint()
        return remoteUsageSnapshotSchema.parse({
          startedAt: response.data.startedAt,
          endedAt: response.data.endedAt,
          inputTokens: response.data.inputTokens,
          outputTokens: response.data.outputTokens,
          totalTokens: response.data.inputTokens + response.data.outputTokens,
          confirmedPlatformCost: null,
          pendingCount: store.outbox.countPending('usage.record'),
          byokEstimatedCostUsd: response.data.estimatedCostUsd,
          byokEstimatedCount: response.data.estimatedCount,
          byokUnavailableCount: response.data.unavailableCount,
          timezone: preferences.timezone,
          displayCurrency: preferences.displayCurrency,
          ...(checkpoint ? { lastSyncAt: new Date(checkpoint.updatedAt).toISOString() } : {}),
        })
      },
      clearLocalData: async (scope) => {
        await maintenance.runExclusive(
          () => activeRequests.size > 0
            || activeChatWork.size > 0
            || activeConversationTitleWork.size > 0
            || activeExecutions.size > 0
            || agent.hasActiveRuns()
            || mediaGeneration.hasActiveRuns()
            || chatDatabase.mediaGenerationJobs.listActive().length > 0
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
      clearBrowserData: async () => {
        const session = await auth.requireSession()
        await maintenance.runExclusive(
          () => activeRequests.size > 0
            || activeChatWork.size > 0
            || activeExecutions.size > 0
            || agent.hasActiveRuns()
            || browserContinuations.hasActiveLease(session.user.id)
            || executions.hasActiveExecutions()
            || browser.hasActiveContexts(),
          async () => {
            await browserContinuations.revokeUser(session.user.id, 'CANCELLED')
            await options.browserWorkspace.clearUserData(session.user.id)
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

  const gateUserDataService = <Service extends object>(service: Service): Service => new Proxy(
    service,
    {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => userDataAdmission.run(
          () => Reflect.apply(value, target, args),
        )
      },
    },
  )
  const services: DesktopIpcServices = {
    ...ungatedServices,
    chat: gateUserDataService(ungatedServices.chat),
    media: gateUserDataService(ungatedServices.media),
    executions: gateUserDataService(ungatedServices.executions),
    settings: {
      ...ungatedServices.settings,
      getTokenUsage: () => userDataAdmission.run(ungatedServices.settings.getTokenUsage),
      recordPrivacyConsent: (input) => userDataAdmission.run(
        () => ungatedServices.settings.recordPrivacyConsent(input),
      ),
      previewLegacyImport: () => userDataAdmission.run(
        ungatedServices.settings.previewLegacyImport,
      ),
      importLegacyData: (input) => userDataAdmission.run(
        () => ungatedServices.settings.importLegacyData(input),
      ),
      getAccountDataPreferences: () => userDataAdmission.run(
        ungatedServices.settings.getAccountDataPreferences,
      ),
      updateAccountDataPreferences: (input) => userDataAdmission.run(
        () => ungatedServices.settings.updateAccountDataPreferences(input),
      ),
      getRemoteUsage: () => userDataAdmission.run(ungatedServices.settings.getRemoteUsage),
      clearLocalData: (scope) => userDataAdmission.run(
        () => ungatedServices.settings.clearLocalData(scope),
      ),
      clearBrowserData: () => userDataAdmission.run(ungatedServices.settings.clearBrowserData),
    },
  }

  let closePromise: Promise<void> | undefined
  return {
    services,
    mediaAssets: {
      resolveReadyAsset: (assetId: string) => userDataAdmission.run(async () => {
        const session = await auth.requireSession()
        const record = chatDatabase.mediaAssets.get(assetId)
        if (!record) throw failure('NOT_FOUND')
        requireOwnedConversation(record.conversationId, session.user.id)
        return media.resolveReadyAsset(assetId)
      }),
    },
    recover: async () => {
      if (closePromise) throw failure('CONFLICT')
      runtimeRecovered = true
      await options.networkProxy.initialize(settings.get().proxy)
      database.recoverInterrupted()
      const session = await auth.getSession()
      if (session) {
        await bindUserData(session)
        chatDatabase.conversations.failInterruptedTitleGenerations()
        chatDatabase.messages.upgradeLegacyApprovals()
        chatDatabase.messages.invalidatePendingAgentApprovals()
        chatDatabase.messages.failInterruptedMediaGenerations()
        chatDatabase.providerUsage.recoverPending(Date.now())
        await mediaLifecycle.recover()
        await videoJobs.recover()
      }
      await removeInterruptedRuntimeDirectories(options.paths.temporary)
      await projects.recoverRemovalJournals()
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
        await capture('admission-drain', () => userDataAdmission.stopAndDrain())
        await capture('admission-drain', () => maintenance.stopAndDrain())
        const reconciliationStopped = Promise.resolve()
          .then(() => pauseUserReconciliation())
          .catch((error: unknown) => { recordFailure(error, 'reconciliation-stop') })
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
        await capture('video-stop', () => videoJobs.stop())
        await capture('chat-drain', async () => {
          const results = await Promise.allSettled([...activeChatWork.values()].map((work) => work.promise))
          for (const result of results) if (result.status === 'rejected') {
            recordFailure(result.reason, 'chat-drain')
          }
          const titleWork = [...activeConversationTitleWork.values()]
          for (const work of titleWork) work.controller.abort()
          const titleResults = await Promise.allSettled(titleWork.map((work) => work.promise))
          for (const result of titleResults) if (result.status === 'rejected') {
            recordFailure(result.reason, 'chat-drain')
          }
          conversationTitleContexts.clear()
        })
        await capture('execution-shutdown', () => executions.shutdown())
        await capture('continuation-shutdown', async () => {
          try { await browserContinuations.shutdown() } finally {
            browserLoginWait.dispose()
            browserManualWait.dispose()
            browserInspector.dispose()
          }
        })
        await capture('browser-shutdown', () => browser.shutdown())
        await reconciliationStopped
        await capture('sync-pause', () => userDataSync.pause())
        await capture('user-cache-close', () => {
          userDataStores.close()
          boundUserId = undefined
        })
        await capture('database-close', () => { database.close() })
        const terminalFailure = failureRecorder.select()
        if (terminalFailure !== undefined) throw terminalFailure.error
      })()
      return closePromise
    },
  }
}
