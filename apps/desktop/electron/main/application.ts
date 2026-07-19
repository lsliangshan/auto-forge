import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  chatBlockSchema,
  openExternalRequestSchema,
  toSafeAppError,
  type AppError,
  type ChatEvent,
  type CredentialStatus,
  type DeveloperProject,
  type ExecutionDetail,
  type ExecutionEvent,
  type ExecutionQuery,
  type ExecutionSummary,
  type ModelInfo,
  type PermissionGrant,
  type WorkflowDetail,
  type WorkflowQuery,
  type WorkflowSummary,
} from '@autoforge/shared'
import type { WorkflowManifest } from '@autoforge/workflow-schema'
import Ajv, { type AnySchema } from 'ajv'
import { AgentOrchestrator, createAgentPersistence } from './agent/agent-orchestrator.js'
import { BrowserCapabilityService, PolicyEngineBrowserAuthorization, type BrowserRuntimeOptions } from './browser/browser-capability.js'
import { OpenRouterProvider, type OpenRouterStreamEvent, type OpenRouterStreamRequest } from './chat/openrouter-provider.js'
import { openAppDatabase } from './database/client.js'
import type { Execution, WorkflowProject } from './database/repositories.js'
import { PolicyEngine } from './permissions/policy-engine.js'
import { SecretStore, type SafeStoragePort } from './security/secret-store.js'
import { SettingsService } from './settings/settings-service.js'
import { removeInterruptedRuntimeDirectories } from './startup.js'
import { ExecutionService, NodeWorkerFactory, type WorkflowExecutionSourceResolver } from './workflows/execution-service.js'
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

export interface ApplicationOpenRouterPort {
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>
  validateCredential(signal?: AbortSignal): Promise<{ valid: boolean }>
  stream(request: OpenRouterStreamRequest): AsyncIterable<OpenRouterStreamEvent>
}

export interface ApplicationRuntimeOptions {
  paths: ApplicationPaths
  safeStorage: SafeStoragePort
  openRouter?: ApplicationOpenRouterPort
  chooseProjectDirectory(): Promise<string | undefined>
  openExternal(url: string): Promise<void>
  emitChat(event: ChatEvent): void
  emitExecution(event: ExecutionEvent): void
  browserRuntime: Omit<BrowserRuntimeOptions, 'developmentExecutablePath'>
  appInfo?: { version: string; platform: 'darwin' | 'win32' }
}

function failure(code: AppError['code']): AppError {
  return toSafeAppError({ code })
}

export class MaintenanceGate {
  private maintenance = false
  private starts = 0

  beginStart(): () => void {
    if (this.maintenance) throw failure('CONFLICT')
    this.starts += 1
    let active = true
    return () => {
      if (!active) return
      active = false
      this.starts -= 1
    }
  }

  clearLocalData(hasActiveWork: () => boolean, clear: () => void): void {
    if (this.maintenance) throw failure('CONFLICT')
    this.maintenance = true
    try {
      if (this.starts > 0 || hasActiveWork()) throw failure('CONFLICT')
      clear()
    } finally {
      this.maintenance = false
    }
  }

  async runExclusive<T>(hasActiveWork: () => boolean, operation: () => Promise<T>): Promise<T> {
    if (this.maintenance) throw failure('CONFLICT')
    this.maintenance = true
    try {
      if (this.starts > 0 || hasActiveWork()) throw failure('CONFLICT')
      return await operation()
    } finally {
      this.maintenance = false
    }
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
    defaultModel: 'openai/gpt-4.1-mini',
    showCosts: true,
    developerMode: false,
    permissionDefault: 'ask',
  })
  const provider = options.openRouter ?? new OpenRouterProvider({ credential: secretStore })
  const projects = new WorkflowProjectService(database, options.paths.installations)
  const registry = new WorkflowRegistry(database, projects)
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
    async resolve(id, version) {
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
        const workflow = await registry.get(id, version, { developerMode: true })
        if (workflow?.source === 'development') {
          return { workflow, rootPath: project.rootPath, entryPath: String(manifest.entryPath), integrity: workflow.integrity }
        }
      }
      return undefined
    },
  }

  const activeExecutions = new Set<string>()
  const activeRequests = new Set<string>()
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
      remove: (path) => rm(path, { recursive: true, force: true }),
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
  const agent = new AgentOrchestrator({
    provider,
    workflows: registry,
    persistence: createAgentPersistence(database),
    policy,
    executions,
    emit: emitChat,
    developerMode: () => settings.get().developerMode,
  })

  const credentialStatus = async (): Promise<CredentialStatus> => {
    const configured = Boolean(await secretStore.get('openrouter_api_key'))
    if (!configured) return { configured: false, valid: false, message: 'OpenRouter API key is not configured.' }
    try {
      const result = await provider.validateCredential()
      return {
        configured: true,
        valid: result.valid,
        ...(result.valid ? {} : { message: 'OpenRouter rejected the credential.' }),
        checkedAt: new Date().toISOString(),
      }
    } catch (error) {
      const safe = toSafeAppError(error)
      return { configured: true, valid: false, message: safe.message, checkedAt: new Date().toISOString() }
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
      deleteConversation: async (conversationId) => {
        if (!database.conversations.get(conversationId)) throw failure('NOT_FOUND')
        database.conversations.delete(conversationId)
      },
      send: async (input) => {
        const releaseStart = maintenance.beginStart()
        try {
          if (!database.conversations.get(input.conversationId)) throw failure('NOT_FOUND')
          const requestId = randomUUID()
          activeRequests.add(requestId)
          void agent.run({
            conversationId: input.conversationId,
            content: input.content,
            model: input.model ?? settings.get().defaultModel,
            requestId,
          }).catch(() => activeRequests.delete(requestId))
          return { requestId }
        } finally {
          releaseStart()
        }
      },
      cancel: (requestId) => agent.cancel(requestId),
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
          const started = await executions.start({ workflowId: manifest.id, workflowVersion: manifest.version, input })
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
      update: async (patch) => settings.update(patch),
      saveOpenRouterKey: async (apiKey) => { await secretStore.set('openrouter_api_key', apiKey); return credentialStatus() },
      clearOpenRouterKey: async () => { secretStore.delete('openrouter_api_key') },
      validateOpenRouterKey: credentialStatus,
      listModels: () => provider.listModels(),
      clearLocalData: async (scope) => {
        maintenance.clearLocalData(
          () => activeRequests.size > 0
            || activeExecutions.size > 0
            || agent.hasActiveRuns()
            || executions.hasActiveExecutions()
            || browser.hasActiveContexts(),
          () => database.clearLocalData(scope),
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
    recover: async () => {
      database.recoverInterrupted()
      await removeInterruptedRuntimeDirectories(options.paths.temporary)
      await projects.recoverRemovalJournals()
    },
    close: async () => {
      await Promise.allSettled([...activeRequests].map((requestId) => agent.cancel(requestId)))
      await Promise.allSettled([...activeExecutions].map(async (executionId) => {
        await executions.cancel(executionId)
        await browser.closeExecution(executionId)
      }))
      database.close()
    },
  }
}
