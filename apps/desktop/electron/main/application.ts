import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  chatBlockSchema,
  conversationGenerationPreferencesSchema,
  openExternalRequestSchema,
  toSafeAppError,
  type AppError,
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
  type WorkflowDetail,
  type WorkflowQuery,
  type WorkflowSummary,
} from '@autoforge/shared'
import type { WorkflowManifest } from '@autoforge/workflow-schema'
import Ajv, { type AnySchema } from 'ajv'
import { AgentOrchestrator, createAgentPersistence } from './agent/agent-orchestrator.js'
import { BrowserCapabilityService, PolicyEngineBrowserAuthorization, type BrowserRuntimeOptions } from './browser/browser-capability.js'
import { DeepSeekProvider } from './chat/deepseek-provider.js'
import { createConversationContextManager } from './chat/conversation-context.js'
import type { ModelProvider } from './chat/model-provider.js'
import { credentialKeyForProvider, ModelProviderRegistry } from './chat/model-provider-registry.js'
import { OpenRouterProvider } from './chat/openrouter-provider.js'
import { MediaGenerationOrchestrator } from './chat/media-generation-orchestrator.js'
import { resolveChatRoute } from './chat/multimodal-router.js'
import type { ModelContentPart } from './chat/model-provider.js'
import { VideoJobRunner } from './chat/video-job-runner.js'
import { openAppDatabase } from './database/client.js'
import type { Execution, WorkflowProject } from './database/repositories.js'
import { PolicyEngine } from './permissions/policy-engine.js'
import { SecretStore, type SafeStoragePort } from './security/secret-store.js'
import { SettingsService } from './settings/settings-service.js'
import { createMediaAssetService } from './media/media-asset-service.js'
import { MediaLifecycle } from './media/media-lifecycle.js'
import { SafeMediaDownloader } from './media/safe-download.js'
import type { NetworkProxyPort } from './network/network-proxy-service.js'
import { removeInterruptedRuntimeDirectories } from './startup.js'
import {
  ExecutionService,
  NodeWorkerFactory,
  type WorkflowExecutionSourceResolver,
  type WorkflowExecutionSourceSelector,
} from './workflows/execution-service.js'
import { WorkflowProjectService } from './workflows/project-service.js'
import { WorkflowRegistry } from './workflows/registry.js'
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

export type ApplicationModelProviderPort = ModelProvider
export type ApplicationOpenRouterPort = ApplicationModelProviderPort

export interface ApplicationRuntimeOptions {
  paths: ApplicationPaths
  safeStorage: SafeStoragePort
  networkProxy: NetworkProxyPort
  openRouter?: ApplicationOpenRouterPort
  modelProviders?: Partial<Record<ModelProviderId, ApplicationModelProviderPort>>
  chooseProjectDirectory(): Promise<string | undefined>
  chooseMediaFiles(remainingSlots: number): Promise<string[]>
  readClipboardImage(): { bytes: Uint8Array; mimeType: 'image/png'; name: string } | undefined
  chooseMediaSavePath(defaultName: string): Promise<string | undefined>
  revealPath(path: string): void
  openExternal(url: string): Promise<void>
  emitChat(event: ChatEvent): void
  emitExecution(event: ExecutionEvent): void
  browserRuntime: Omit<BrowserRuntimeOptions, 'developmentExecutablePath'>
  appInfo?: { version: string; platform: 'darwin' | 'win32' }
  removeExecutionTemporaryDirectory?(path: string): Promise<void>
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

function projectFiles(root: string): Promise<string[]> {
  const ignoredDirectories = new Set(['.git', 'node_modules'])
  const visit = async (directory: string, prefix = ''): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true })
    const files = await Promise.all(entries.filter((entry) => !entry.isSymbolicLink()
      && !(entry.isDirectory() && ignoredDirectories.has(entry.name))).map(async (entry) => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      return entry.isDirectory() ? visit(join(directory, entry.name), relative) : [relative]
    }))
    return files.flat().sort()
  }
  return visit(root)
}

async function developerProject(project: WorkflowProject): Promise<DeveloperProject> {
  return {
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
    status: ['new', 'building', 'ready', 'invalid', 'error'].includes(project.status)
      ? project.status as DeveloperProject['status']
      : 'error',
    files: await projectFiles(project.rootPath),
    updatedAt: new Date(project.updatedAt).toISOString(),
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
  const maintenance = new MaintenanceGate()
  const secretStore = new SecretStore(database.encryptedSecrets, options.safeStorage)
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
  const providerRegistry = new ModelProviderRegistry({
    openrouter: options.modelProviders?.openrouter ?? options.openRouter ?? new OpenRouterProvider({
      credential: secretStore,
      fetch: options.networkProxy.fetch.bind(options.networkProxy) as typeof globalThis.fetch,
    }),
    deepseek: options.modelProviders?.deepseek ?? new DeepSeekProvider({
      credential: secretStore,
      fetch: options.networkProxy.fetch.bind(options.networkProxy) as typeof globalThis.fetch,
    }),
  })
  const projects = new WorkflowProjectService(database, options.paths.installations)
  const registry = new WorkflowRegistry(database, projects)
  const media = createMediaAssetService({ database, mediaRoot: join(options.paths.data, 'media') })
  const mediaLifecycle = new MediaLifecycle({
    database,
    mediaRoot: join(options.paths.data, 'media'),
  })
  const modelCatalog = new Map<ModelProviderId, Promise<Awaited<ReturnType<ModelProvider['listModels']>>>>()
  const getModelCatalog = (provider: ModelProviderId) => {
    let catalog = modelCatalog.get(provider)
    if (!catalog) {
      catalog = providerRegistry.get(provider).listModels()
        .catch((error) => {
          modelCatalog.delete(provider)
          throw error
        })
      modelCatalog.set(provider, catalog)
    }
    return catalog
  }
  const developmentSourceSelectors = new WeakMap<WorkflowExecutionSourceSelector, string>()
  const selectDevelopmentProject = (projectId: string): WorkflowExecutionSourceSelector => {
    const selector = Object.freeze({ kind: 'development-project' as const, projectId })
    developmentSourceSelectors.set(selector, projectId)
    return selector
  }
  const policy = new PolicyEngine(database.permissionGrants)
  const browser = new BrowserCapabilityService({
    authorization: new PolicyEngineBrowserAuthorization(policy),
    runtime: options.browserRuntime,
    profileDirectories: {
      create: async () => { await mkdir(options.paths.temporary, { recursive: true }); return mkdtemp(join(options.paths.temporary, 'autoforge-browser-')) },
      remove: (path) => rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
    },
  })
  const sourceResolver: WorkflowExecutionSourceResolver = {
    async resolve(id, version, selector) {
      if (selector) {
        const projectId = developmentSourceSelectors.get(selector)
        if (!projectId || selector.kind !== 'development-project' || selector.projectId !== projectId) return undefined
        const project = database.workflowProjects.get(projectId)
        const workflow = await registry.getDevelopmentProject(projectId)
        if (!project || !workflow) return undefined
        const manifest = JSON.parse(await projects.read(projectId, 'workflow.json')) as WorkflowManifest
        if (manifest.id !== id || manifest.version !== version) return undefined
        return {
          workflow,
          rootPath: project.rootPath,
          entryPath: String(manifest.entryPath),
          integrity: workflow.integrity,
        }
      }
      const installed = database.installedWorkflows.get(id, version)
      if (installed) {
        const integrity = await registry.verifyIntegrity(id, version)
        const workflow = await registry.get(id, version, { developerMode: false })
        if (!workflow || !integrity.valid) return undefined
        const manifest = installed.manifest as WorkflowManifest
        return { workflow, rootPath: installed.installPath, entryPath: manifest.entryPath, integrity: workflow.integrity }
      }
      for (const project of database.workflowProjects.list()) {
        const manifest = project.manifest as Partial<WorkflowManifest> | undefined
        if (project.status !== 'ready' || manifest?.id !== id || manifest.version !== version) continue
        const workflow = await registry.getDevelopmentProject(project.id)
        if (workflow) {
          return { workflow, rootPath: project.rootPath, entryPath: String(manifest.entryPath), integrity: workflow.integrity }
        }
      }
      return undefined
    },
  }

  const activeExecutions = new Set<string>()
  const activeRequests = new Set<string>()
  const activeChatWork = new Map<string, {
    conversationId: string
    promise: Promise<void>
  }>()
  let acceptingWork = true
  const emitExecution = (event: ExecutionEvent) => {
    if (event.type === 'status') {
      if (['queued', 'awaiting_approval', 'running'].includes(event.status)) activeExecutions.add(event.executionId)
      else activeExecutions.delete(event.executionId)
    }
    try { options.emitExecution(event) } catch { /* Renderer events are observational. */ }
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
    if (event.type === 'status' && ['completed', 'cancelled', 'failed'].includes(event.status)) activeRequests.delete(event.requestId)
    if (event.type === 'block' && event.block.type === 'approval') {
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
    try { options.emitChat(event) } catch { /* Renderer events are observational. */ }
  }
  const conversationContext = createConversationContextManager(database)
  const agent = new AgentOrchestrator({
    providers: providerRegistry,
    workflows: registry,
    persistence: createAgentPersistence(database),
    history: conversationContext,
    policy,
    executions,
    emit: emitChat,
    developerMode: () => settings.get().developerMode,
  })
  const persistence = createAgentPersistence(database)
  const mediaGeneration = new MediaGenerationOrchestrator({
    providers: providerRegistry,
    persistence,
    media,
    downloader: new SafeMediaDownloader({
      fetch: options.networkProxy.fetch.bind(options.networkProxy),
    }),
    emit: emitChat,
  })
  const videoJobs = new VideoJobRunner({
    database,
    providers: providerRegistry,
    media,
    emit: emitChat,
  })

  const requireValidCredential = async (provider: ModelProviderId): Promise<void> => {
    if (database.encryptedSecrets.raw(credentialKeyForProvider(provider)) === undefined) {
      throw failure('CREDENTIAL_UNAVAILABLE')
    }
    const result = await providerRegistry.get(provider).validateCredential()
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
      const result = await providerRegistry.get(provider).validateCredential()
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

  const services: DesktopIpcServices = {
    chat: {
      listConversations: async () => database.conversations.list().map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        createdAt: new Date(conversation.createdAt).toISOString(),
        updatedAt: new Date(conversation.updatedAt).toISOString(),
      })),
      listMessages: async (conversationId) => {
        if (!database.conversations.get(conversationId)) throw failure('NOT_FOUND')
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
        const conversation = database.conversations.insert({ id: randomUUID(), title: '新会话' })
        return { ...conversation, createdAt: new Date(conversation.createdAt).toISOString(), updatedAt: new Date(conversation.updatedAt).toISOString() }
      },
      renameConversation: async (conversationId, title) => {
        const conversation = database.conversations.update(conversationId, { title })
        if (!conversation) throw failure('NOT_FOUND')
        return { ...conversation, createdAt: new Date(conversation.createdAt).toISOString(), updatedAt: new Date(conversation.updatedAt).toISOString() }
      },
      deleteConversation: (conversationId) => maintenance.runExclusive(
        () => [...activeChatWork.values()].some((work) => work.conversationId === conversationId)
          || database.mediaGenerationJobs.listActive()
            .some((job) => job.conversationId === conversationId),
        async () => {
          if (!database.conversations.get(conversationId)) throw failure('NOT_FOUND')
          await mediaLifecycle.deleteConversation(conversationId)
        },
      ),
      send: async (input) => {
        const releaseStart = maintenance.beginStart()
        try {
          if (!acceptingWork) throw failure('CONFLICT')
          if (!database.conversations.get(input.conversationId)) throw failure('NOT_FOUND')
          const snapshot = settings.get()
          const preferences = conversationGenerationPreferencesSchema.parse(
            database.conversations.get(input.conversationId)?.generationPreferences
              ?? defaultGenerationPreferences,
          )
          const requestedOutput = input.outputType === 'auto'
            ? preferences.outputType
            : input.outputType
          if (
            snapshot.activeProvider === 'deepseek'
            && (input.assetIds.length > 0
              || (requestedOutput !== 'auto' && requestedOutput !== 'text'))
          ) throw failure('MODEL_MODALITY_UNSUPPORTED')
          await requireValidCredential(snapshot.activeProvider)
          const resolved = await resolvedInput(input.conversationId, input.assetIds)
          const route = resolveChatRoute({
            provider: snapshot.activeProvider,
            ...(input.model === undefined ? {} : { requestedModel: input.model }),
            requestedOutput: input.outputType,
            requestedGeneration: input.generation,
            defaults: snapshot.defaultModels,
            conversationPreferences: preferences,
            models: await getModelCatalog(snapshot.activeProvider),
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
            activeRequests.add(requestId)
            const promise = Promise.resolve().then(async () => {
              await agent.run({
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
                provider: route.provider,
                model: route.model,
                ...(route.contextLength === undefined ? {} : { contextLength: route.contextLength }),
                requestId,
              })
            }).catch(() => undefined).finally(() => {
              activeRequests.delete(requestId)
              activeChatWork.delete(requestId)
            })
            activeChatWork.set(requestId, { conversationId: input.conversationId, promise })
          } else if (route.outputType === 'image') {
            activeRequests.add(requestId)
            const promise = Promise.resolve().then(async () => {
              await mediaGeneration.runImage(generationInput)
            }).catch(() => undefined).finally(() => {
              activeRequests.delete(requestId)
              activeChatWork.delete(requestId)
            })
            activeChatWork.set(requestId, { conversationId: input.conversationId, promise })
          } else if (route.outputType === 'audio') {
            activeRequests.add(requestId)
            const promise = Promise.resolve().then(async () => {
              await mediaGeneration.runAudio(generationInput)
            }).catch(() => undefined).finally(() => {
              activeRequests.delete(requestId)
              activeChatWork.delete(requestId)
            })
            activeChatWork.set(requestId, { conversationId: input.conversationId, promise })
          } else {
            await videoJobs.submit({
              ...generationInput,
              route: { ...route, outputType: 'video' },
            })
          }
          return { requestId }
        } finally {
          releaseStart()
        }
      },
      cancel: async (requestId) => {
        await Promise.allSettled([
          agent.cancel(requestId),
          mediaGeneration.cancel(requestId),
        ])
      },
      getGenerationPreferences: async (conversationId) => {
        const conversation = database.conversations.get(conversationId)
        if (!conversation) throw failure('NOT_FOUND')
        return conversationGenerationPreferencesSchema.parse(
          conversation.generationPreferences ?? defaultGenerationPreferences,
        )
      },
      updateGenerationPreferences: async (conversationId, preferences) => {
        const normalized = conversationGenerationPreferencesSchema.safeParse(preferences)
        if (!normalized.success) throw failure('INVALID_INPUT')
        const conversation = database.conversations.updateGenerationPreferences(conversationId, normalized.data)
        if (!conversation?.generationPreferences) throw failure('NOT_FOUND')
        return conversationGenerationPreferencesSchema.parse(conversation.generationPreferences)
      },
    },
    media: {
      pickFiles: async (context) => {
        const remainingSlots = 5 - context.existingAssetIds.length
        if (remainingSlots <= 0) return []
        const paths = (await options.chooseMediaFiles(remainingSlots)).filter(Boolean)
        return media.importPaths({ ...context, paths })
      },
      importDroppedFiles: (input) => media.importPaths(input),
      importClipboardImage: async (context) => {
        const image = options.readClipboardImage()
        return image ? media.importClipboardImage({ ...context, ...image }) : []
      },
      removeDraft: ({ conversationId, assetId }) => media.removeDraft(assetId, conversationId),
      saveCopy: async (assetId) => {
        const asset = await media.resolveReadyAsset(assetId)
        const destination = await options.chooseMediaSavePath(asset.name)
        if (destination) await copyFile(asset.absolutePath, destination)
      },
      reveal: async (assetId) => {
        const asset = await media.resolveReadyAsset(assetId)
        options.revealPath(asset.absolutePath)
      },
      pauseVideoJob: (jobId) => videoJobs.pause(jobId),
      resumeVideoJob: (jobId) => videoJobs.resume(jobId),
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
      build: async (projectId) => developerProject(await projects.build(projectId)),
      validate: (projectId) => projects.validate(projectId),
      run: async ({ projectId, input }) => {
        const releaseStart = maintenance.beginStart()
        try {
          const built = await projects.build(projectId)
          const manifest = built.manifest as WorkflowManifest
          try {
            const validateInput = new Ajv({ allErrors: true, strict: false }).compile(manifest.inputSchema as AnySchema)
            if (!validateInput(input)) throw failure('INVALID_INPUT')
          } catch (error) {
            if (typeof error === 'object' && error !== null && 'code' in error) throw error
            throw failure('INVALID_INPUT')
          }
          const started = await executions.start({
            workflowId: manifest.id,
            workflowVersion: manifest.version,
            input,
            sourceSelector: selectDevelopmentProject(projectId),
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
        const result = await agent.resumeApproval(decision)
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
      update: async (patch) => {
        const previous = settings.get()
        const candidate = settings.preview(patch)
        if (JSON.stringify(previous.proxy) === JSON.stringify(candidate.proxy)) {
          return settings.commit(candidate)
        }
        await options.networkProxy.transition(candidate.proxy)
        try {
          return settings.commit(candidate)
        } catch {
          await options.networkProxy.transition(previous.proxy)
          throw failure('INTERNAL_ERROR')
        }
      },
      saveProviderApiKey: async (provider, apiKey) => {
        await secretStore.set(credentialKeyForProvider(provider), apiKey)
        modelCatalog.delete(provider)
        return { provider, configured: true, validation: 'unchecked' as const }
      },
      clearProviderApiKey: async (provider) => {
        secretStore.delete(credentialKeyForProvider(provider))
        modelCatalog.delete(provider)
      },
      validateProviderCredential: credentialStatus,
      listProviderModels: (provider) => getModelCatalog(provider),
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

  return {
    services,
    mediaAssets: {
      resolveReadyAsset: media.resolveReadyAsset,
    },
    recover: async () => {
      await options.networkProxy.initialize(settings.get().proxy)
      await mediaLifecycle.recover()
      database.recoverInterrupted()
      await removeInterruptedRuntimeDirectories(options.paths.temporary)
      await projects.recoverRemovalJournals()
      await videoJobs.recover()
    },
    close: async () => {
      acceptingWork = false
      const admittedStarts = maintenance.stopAndDrain()
      await videoJobs.stop()
      await admittedStarts
      await Promise.allSettled([...activeRequests].flatMap((requestId) => [
        agent.cancel(requestId),
        mediaGeneration.cancel(requestId),
      ]))
      await Promise.allSettled([...activeChatWork.values()].map((work) => work.promise))
      await executions.shutdown()
      database.close()
    },
  }
}
