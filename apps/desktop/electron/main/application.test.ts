import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  authCredentialsSchema,
  authOtpRequestSchema,
  authOtpVerificationSchema,
  developerRunResultSchema,
  toSafeAppError,
  type AppError,
  type AuthCredentials,
  type AuthOtpRequest,
  type AuthSession,
  type ChatEvent,
  type ChatSendInput,
  type ExecutionEvent,
  type ModelInfo,
  type ProxySettings,
} from '@autoforge/shared'
import {
  createApplicationFailureRecorder,
  createApplicationRuntime,
  createWorkflowExecutionSourceResolver,
  MaintenanceGate,
  observeAuthService,
} from './application.js'
import { AgentOrchestrator } from './agent/agent-orchestrator.js'
import type { AuthService } from './auth/auth-service.js'
import type { BusinessRoleService } from './auth/cloudbase-role-service.js'
import type { BrowserWorkspacePort, BrowserWorkspaceTab } from './browser/electron-browser-workspace.js'
import { MediaGenerationOrchestrator } from './chat/media-generation-orchestrator.js'
import { VideoJobRunner } from './chat/video-job-runner.js'
import type { ModelProvider, ModelProviderSnapshot, ModelStreamRequest } from './chat/model-provider.js'
import type { CredentialBoundModelProvider } from './chat/model-provider-registry.js'
import { openAppDatabase } from './database/client.js'
import { ProviderUsageConsistencyError } from './database/repositories.js'
import {
  NetworkProxyService,
  type NetworkProxyPort,
  type NetworkTransportSnapshot,
} from './network/network-proxy-service.js'
import { SecretStore } from './security/secret-store.js'
import { SettingsService } from './settings/settings-service.js'
import { fingerprintApiKey, ProviderUsageReconciler } from './billing/provider-usage-reconciler.js'
import { ExecutionService } from './workflows/execution-service.js'
import { createWorkflowSourceSelectorVault } from './workflows/workflow-source-selector.js'

const directories: string[] = []
const { recoveryProbe } = vi.hoisted(() => ({ recoveryProbe: vi.fn() }))

vi.mock('./startup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./startup.js')>()
  return {
    ...actual,
    removeInterruptedRuntimeDirectories: async (path: string) => {
      recoveryProbe()
      await actual.removeInterruptedRuntimeDirectories(path)
    },
  }
})

function createNetworkProxy() {
  const settings = Object.freeze({
    enabled: false,
    bypassDomains: Object.freeze([] as string[]) as string[],
  })
  const withTransportLease = vi.fn((
    operation: (snapshot: NetworkTransportSnapshot) => Promise<unknown>,
  ): Promise<unknown> => operation({ settings })) as unknown as NetworkProxyPort['withTransportLease']
  const transition = vi.fn().mockResolvedValue(undefined)
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    transition,
    transitionOrFailClosed: transition,
    fetch: vi.fn(globalThis.fetch),
    snapshot: vi.fn(async () => ({ enabled: false, bypassRules: '<local>', playwrightArgs: [] })),
    withTransportLease,
  }
}

function createBrowserWorkspace(): BrowserWorkspacePort {
  let currentUrl = ''
  const tab: BrowserWorkspaceTab = {
    open: vi.fn(async (url) => { currentUrl = url }),
    fill: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    url: vi.fn(async () => currentUrl),
    close: vi.fn(async () => undefined),
  }
  return {
    acquire: vi.fn(async () => tab),
    releaseExecution: vi.fn(async () => undefined),
    updateProxy: vi.fn(async () => undefined),
    reset: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function serializedProxyHarness() {
  const firstStarted = deferred<void>()
  const releaseFirst = deferred<void>()
  let transitionTail = Promise.resolve()
  let transitionIndex = 0
  let liveProxy: ProxySettings = { enabled: false, bypassDomains: [] }
  const transition = vi.fn((next: ProxySettings) => {
    const index = transitionIndex++
    const result = transitionTail.then(async () => {
      if (index === 0) {
        firstStarted.resolve()
        await releaseFirst.promise
      }
      liveProxy = structuredClone(next)
    })
    transitionTail = result.catch(() => undefined)
    return result
  })
  return {
    networkProxy: { ...createNetworkProxy(), transition, transitionOrFailClosed: transition },
    firstStarted: firstStarted.promise,
    releaseFirst: () => releaseFirst.resolve(),
    liveProxy: () => structuredClone(liveProxy),
  }
}

let networkProxy = createNetworkProxy()
type RuntimeOptions = Parameters<typeof createApplicationRuntime>[0]

function createTestAuthService(): AuthService {
  const users = new Map<string, { session: AuthSession; password: string; target: string }>()
  const challenges = new Map<string, AuthOtpRequest>()
  let currentSession: AuthSession | null = null
  let challengeSequence = 0

  const failure = (code: AppError['code']) => toSafeAppError({ code })
  const sessionFor = (account: string): AuthSession => ({
    user: { id: `test_user_${account.toLowerCase()}`, account },
    authenticatedAt: new Date(0).toISOString(),
  })

  return {
    async getSession() { return currentSession },
    async sendOtp(input) {
      const parsed = authOtpRequestSchema.safeParse(input)
      if (!parsed.success) throw failure('INVALID_INPUT')
      if (parsed.data.intent === 'register' && users.has(parsed.data.account.toLowerCase())) {
        throw failure('AUTH_ACCOUNT_EXISTS')
      }
      if (parsed.data.intent === 'login'
        && ![...users.values()].some((user) => user.target === parsed.data.target)) {
        throw failure('AUTH_ACCOUNT_NOT_FOUND')
      }
      challenges.clear()
      const challengeId = `test_challenge_${++challengeSequence}`
      challenges.set(challengeId, parsed.data)
      return { challengeId, expiresIn: 300 }
    },
    async verifyOtp(input) {
      const parsed = authOtpVerificationSchema.safeParse(input)
      if (!parsed.success) throw failure('INVALID_INPUT')
      const challenge = challenges.get(parsed.data.challengeId)
      challenges.delete(parsed.data.challengeId)
      if (!challenge) throw failure('AUTH_OTP_EXPIRED')
      if (parsed.data.code !== '123456') throw failure('AUTH_INVALID_OTP')
      if (challenge.intent === 'register') {
        const session = sessionFor(challenge.account)
        users.set(challenge.account.toLowerCase(), {
          session,
          password: challenge.password,
          target: challenge.target,
        })
        currentSession = session
        return session
      }
      const user = [...users.values()].find((candidate) => candidate.target === challenge.target)
      if (!user) throw failure('AUTH_ACCOUNT_NOT_FOUND')
      currentSession = user.session
      return user.session
    },
    async cancelOtp(challengeId) {
      const parsed = authOtpVerificationSchema.shape.challengeId.safeParse(challengeId)
      if (!parsed.success) throw failure('INVALID_INPUT')
      challenges.delete(parsed.data)
    },
    async loginWithPassword(input: AuthCredentials) {
      const parsed = authCredentialsSchema.safeParse(input)
      if (!parsed.success) throw failure('INVALID_INPUT')
      const user = users.get(parsed.data.account.toLowerCase())
      if (!user || user.password !== parsed.data.password) throw failure('AUTH_INVALID_CREDENTIALS')
      currentSession = user.session
      return user.session
    },
    async updateUserProfile(input) {
      if (!currentSession) throw failure('AUTH_REQUIRED')
      currentSession = {
        ...currentSession,
        user: {
          ...currentSession.user,
          profile: { ...currentSession.user.profile, ...input },
        },
      }
      return currentSession.user
    },
    async discardSession() {
      challenges.clear()
      currentSession = null
    },
    async logout() {
      challenges.clear()
      currentSession = null
    },
    async requireSession() {
      if (!currentSession) throw failure('AUTH_REQUIRED')
      return currentSession
    },
  }
}

function snapshotProvider(
  providerId: 'openrouter' | 'deepseek',
  provider: ModelProvider,
): CredentialBoundModelProvider {
  const bound: CredentialBoundModelProvider = {
    listModels: (signal) => provider.listModels(signal),
    validateCredential: (signal) => provider.validateCredential(signal),
    stream: (request) => provider.stream(request),
    ...(provider.generateImage === undefined ? {} : {
      generateImage: (request) => provider.generateImage!(request),
    }),
    ...(provider.submitVideo === undefined ? {} : {
      submitVideo: (request) => provider.submitVideo!(request),
    }),
    ...(provider.pollVideo === undefined ? {} : {
      pollVideo: (providerJobId, signal) => provider.pollVideo!(providerJobId, signal),
    }),
    ...(provider.downloadVideo === undefined ? {} : {
      downloadVideo: (providerJobId, signal) => provider.downloadVideo!(providerJobId, signal),
    }),
    ...(provider.getGenerationUsage === undefined ? {} : {
      getGenerationUsage: (generationId, signal) => provider.getGenerationUsage!(generationId, signal),
    }),
    acquireSnapshot: vi.fn(async (): Promise<ModelProviderSnapshot> => ({
      providerId,
      provider: bound,
      ...(providerId === 'openrouter' ? { apiKeyFingerprint: 'fingerprint_test' } : {}),
    })),
  }
  return bound
}

function snapshotProviders(
  providers: Partial<Record<'openrouter' | 'deepseek', ModelProvider>>,
): NonNullable<RuntimeOptions['modelProviders']> {
  return Object.fromEntries(Object.entries(providers).map(([providerId, provider]) => [
    providerId,
    snapshotProvider(providerId as 'openrouter' | 'deepseek', provider),
  ]))
}

function options(
  root: string,
  overrides: Partial<RuntimeOptions> = {},
): RuntimeOptions {
  const authService = createTestAuthService()
  return {
    paths: {
      database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
      projects: join(root, 'projects'), installations: join(root, 'workflows'),
      workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
    },
    safeStorage: {
      isAvailable: async () => true,
      encrypt: async (value) => Buffer.from(value),
      decrypt: async (value) => ({ value: value.toString(), shouldReEncrypt: false }),
    },
    chooseProjectDirectory: async () => undefined,
    chooseMediaFiles: async () => [],
    readClipboardImage: () => undefined,
    chooseMediaSavePath: async () => undefined,
    revealPath: () => undefined,
    openExternal: async () => undefined,
    emitChat: vi.fn(),
    emitExecution: vi.fn(),
    networkProxy,
    browserWorkspace: createBrowserWorkspace(),
    authService,
    ...overrides,
  }
}

function chatInput(conversationId: string, content: string): ChatSendInput {
  return {
    conversationId,
    content,
    assetIds: [],
    outputType: 'auto',
    generation: {
      image: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
      audio: { format: 'mp3' },
      video: { durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false },
    },
  }
}

async function authenticate(
  runtime: ReturnType<typeof createApplicationRuntime>,
  account = 'TestUser',
) {
  const challenge = await runtime.services.auth.sendOtp({
    intent: 'register',
    channel: 'email',
    target: `${account.toLowerCase()}@example.com`,
    account,
    password: 'password',
  })
  return runtime.services.auth.verifyOtp({
    challengeId: challenge.challengeId,
    code: '123456',
  })
}

async function installApprovalWorkflow(
  runtime: ReturnType<typeof createApplicationRuntime>,
  activation = 'approval workflow',
) {
  const project = await runtime.services.developer.createProject('Approval Workflow')
  const manifest = JSON.parse(
    await runtime.services.developer.readFile(project.id, 'workflow.json'),
  ) as Record<string, unknown>
  Object.assign(manifest, {
    id: 'local.autoforge.approval-workflow',
    version: '1.0.0',
    permissions: [{ capability: 'browser.open', scope: { origins: ['https://example.com'] } }],
    activationExamples: [activation],
    inputSchema: { type: 'object', additionalProperties: false },
  })
  await runtime.services.developer.writeFile(project.id, 'workflow.json', `${JSON.stringify(manifest, null, 2)}\n`)
  await runtime.services.developer.writeFile(project.id, 'src/index.ts', [
    "import { defineWorkflow } from '@autoforge/workflow-sdk'",
    'export default defineWorkflow({ async run() { return { ok: true } } })',
  ].join('\n'))
  await runtime.services.developer.build(project.id)
  return runtime.services.workflows.installProject(project.id)
}

function modelInfo(id: string, name: string): ModelInfo {
  return { id, name, inputModalities: ['text'], outputModalities: ['text'], supportsTools: false, generation: {} }
}

function imageModelInfo(id: string): ModelInfo {
  return {
    id,
    name: id,
    inputModalities: ['text', 'image'],
    outputModalities: ['image'],
    supportsTools: false,
    generation: {
      image: {
        resolutions: ['1K'],
        aspectRatios: ['auto'],
        formats: ['png'],
        maxCount: 1,
      },
    },
  }
}

function audioModelInfo(id: string): ModelInfo {
  return {
    id,
    name: id,
    inputModalities: ['text', 'audio'],
    outputModalities: ['audio'],
    supportsTools: false,
    generation: { audio: { voices: [], formats: ['mp3'] } },
  }
}

function videoModelInfo(id: string): ModelInfo {
  return {
    id,
    name: id,
    inputModalities: ['text', 'image'],
    outputModalities: ['video'],
    supportsTools: false,
    generation: {
      video: {
        resolutions: ['720p'],
        aspectRatios: ['auto'],
        durations: [5],
        supportsAudio: false,
        frameImages: ['first_frame', 'last_frame'],
      },
    },
  }
}

function visionTextModelInfo(id: string): ModelInfo {
  return {
    ...modelInfo(id, id),
    inputModalities: ['text', 'image'],
    supportsTools: true,
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

beforeEach(() => {
  networkProxy = createNetworkProxy()
  recoveryProbe.mockClear()
})

describe('createApplicationRuntime', () => {
  it('rejects selector-less resolution instead of using an id and version fallback', async () => {
    const vault = createWorkflowSourceSelectorVault()
    const installed = {
      id: 'workflow.installed', version: '1.0.0', name: 'Installed', description: 'Installed build',
      author: 'AutoForge', category: 'test', enabled: true, source: 'installed' as const,
      integrity: 'valid' as const, updatedAt: '2026-08-22T00:00:00.000Z', codeSha256: 'a'.repeat(64), cities: [],
      runtimeIdentity: { id: 'workflow.installed', version: '1.0.0', source: 'installed' as const },
      permissions: [], activationExamples: [], activationNegativeExamples: [], timeoutMs: 30_000,
      inputSchema: {}, outputSchema: { selected: 'installed' },
    }
    const resolver = createWorkflowExecutionSourceResolver(vault, {
      repositories: {
        workflowProjects: { list: () => [] },
        installedWorkflows: { get: () => ({
          manifest: { id: installed.id, version: installed.version, entryPath: 'dist/index.js', codeSha256: installed.codeSha256 },
          installPath: '/tmp/installed',
        }) },
      },
      registry: {
        getDevelopmentProject: async () => undefined,
        get: async () => installed,
        verifyIntegrity: async () => ({ valid: true, disabled: false }),
      },
    } as never)

    await expect(resolver.resolve(installed.id, installed.version, undefined as never)).resolves.toBeUndefined()
  })

  it('rejects a development selector after its persisted build changes without falling back to an installed duplicate', async () => {
    const vault = createWorkflowSourceSelectorVault()
    const development = {
      id: 'workflow.same', version: '1.0.0', name: 'Development', description: 'Development build',
      author: 'AutoForge', category: 'test', enabled: true, source: 'development' as const,
      integrity: 'valid' as const, updatedAt: '2026-08-22T00:00:00.000Z', codeSha256: 'a'.repeat(64), cities: [],
      runtimeIdentity: { id: 'workflow.same', version: '1.0.0', source: 'development' as const, buildHash: 'b'.repeat(64) },
      permissions: [], activationExamples: [], activationNegativeExamples: [], timeoutMs: 30_000,
      inputSchema: {}, outputSchema: { selected: 'development' },
    }
    const project = {
      id: 'project_dev', name: 'Development', rootPath: '/tmp/development', status: 'ready',
      buildHash: 'b'.repeat(64), manifest: { id: development.id, version: development.version, entryPath: 'dist/index.js', codeSha256: development.codeSha256 },
      createdAt: 0, updatedAt: 0,
    }
    const installedFallback = vi.fn(async () => ({
      ...development,
      source: 'installed' as const,
      runtimeIdentity: { id: development.id, version: development.version, source: 'installed' as const },
      outputSchema: { selected: 'installed' },
    }))
    const resolver = createWorkflowExecutionSourceResolver(vault, {
      repositories: {
        workflowProjects: { list: () => [project] },
        installedWorkflows: { get: () => ({ manifest: { codeSha256: development.codeSha256 } }) },
      },
      registry: {
        getDevelopmentProject: async () => development,
        get: installedFallback,
        verifyIntegrity: async () => ({ valid: true, disabled: false }),
      },
    } as never)
    const selector = vault.create(development)

    await expect(resolver.resolve(development.id, development.version, selector)).resolves.toMatchObject({
      workflow: { source: 'development', outputSchema: { selected: 'development' } },
    })

    project.buildHash = 'c'.repeat(64)
    await expect(resolver.resolve(development.id, development.version, selector)).resolves.toBeUndefined()
    expect(installedFallback).not.toHaveBeenCalled()
  })

  it('rejects a development selector when more than one project matches its exact build', async () => {
    const vault = createWorkflowSourceSelectorVault()
    const workflow = {
      id: 'workflow.same', version: '1.0.0', name: 'Development', description: 'Development build',
      author: 'AutoForge', category: 'test', enabled: true, source: 'development' as const,
      integrity: 'valid' as const, updatedAt: '2026-08-22T00:00:00.000Z', codeSha256: 'a'.repeat(64), cities: [],
      runtimeIdentity: { id: 'workflow.same', version: '1.0.0', source: 'development' as const, buildHash: 'b'.repeat(64) },
      permissions: [], activationExamples: [], activationNegativeExamples: [], timeoutMs: 30_000,
      inputSchema: {}, outputSchema: {},
    }
    const project = (id: string) => ({
      id, name: id, rootPath: `/tmp/${id}`, status: 'ready', buildHash: 'b'.repeat(64),
      manifest: { id: workflow.id, version: workflow.version, entryPath: 'dist/index.js', codeSha256: workflow.codeSha256 },
      createdAt: 0, updatedAt: 0,
    })
    const resolver = createWorkflowExecutionSourceResolver(vault, {
      repositories: {
        workflowProjects: { list: () => [project('project_one'), project('project_two')] },
        installedWorkflows: { get: () => undefined },
      },
      registry: {
        getDevelopmentProject: async () => workflow,
        get: async () => undefined,
        verifyIntegrity: async () => ({ valid: false, disabled: false }),
      },
    } as never)

    await expect(resolver.resolve(workflow.id, workflow.version, vault.create(workflow))).resolves.toBeUndefined()
  })

  it('requires the CloudBase role before projecting a login and fails closed on refresh', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-role-'))
    directories.push(root)
    const ensureMyRole = vi.fn().mockResolvedValue({
      role: 'super_admin',
      capabilities: ['manage_users'],
      version: 2,
      updatedAt: '2026-08-21T00:00:00.000Z',
      confirmed: true,
    })
    const roleService: BusinessRoleService = {
      ensureMyRole,
      listUsers: vi.fn(),
      updateUserRole: vi.fn(),
    }
    const runtime = createApplicationRuntime(options(root, { roleService }))

    const session = await authenticate(runtime, 'Admin')
    expect(session.authorization).toMatchObject({
      role: 'super_admin', capabilities: ['manage_users'], confirmed: true,
    })
    expect(ensureMyRole).toHaveBeenCalledOnce()
    const sqlite = new Database(join(root, 'autoforge.sqlite'), { readonly: true })
    expect(sqlite.prepare(`
      SELECT role, version FROM local_user_roles WHERE user_id = ?
    `).get(session.user.id)).toEqual({ role: 'super_admin', version: 2 })
    sqlite.close()

    ensureMyRole.mockRejectedValueOnce(toSafeAppError({ code: 'SERVICE_UNAVAILABLE' }))
    await expect(runtime.services.auth.refreshAuthorization()).resolves.toMatchObject({
      authorization: { role: 'super_admin', capabilities: [], confirmed: false },
    })
    await runtime.close()
  })

  it('discards a newly authenticated session when the role service is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-role-error-'))
    directories.push(root)
    const authService = createTestAuthService()
    const discardSession = vi.spyOn(authService, 'discardSession')
    const roleService: BusinessRoleService = {
      ensureMyRole: vi.fn().mockRejectedValue(toSafeAppError({ code: 'SERVICE_UNAVAILABLE' })),
      listUsers: vi.fn(),
      updateUserRole: vi.fn(),
    }
    const runtime = createApplicationRuntime(options(root, { authService, roleService }))

    await expect(authenticate(runtime, 'Alice')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(discardSession).toHaveBeenCalled()
    const sqlite = new Database(join(root, 'autoforge.sqlite'), { readonly: true })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM local_auth_session').get()).toEqual({ count: 0 })
    sqlite.close()
    await runtime.close()
  })

  it('stays unauthenticated when local session cleanup fails after CloudBase logout', async () => {
    const delegate = createTestAuthService()
    const clearSession = vi.fn(() => {
      throw new Error('local database unavailable')
    })
    const auth = observeAuthService(delegate, {
      sync: (session) => ({
        user: session.user,
        authenticatedAt: Date.parse(session.authenticatedAt),
      }),
      clearSession,
    })
    const challenge = await auth.sendOtp({
      intent: 'register',
      channel: 'email',
      target: 'alice@example.com',
      account: 'Alice',
      password: 'password',
    })
    await auth.verifyOtp({ challengeId: challenge.challengeId, code: '123456' })
    expect(auth.isAuthenticated()).toBe(true)

    await expect(auth.logout()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(auth.isAuthenticated()).toBe(false)
    expect(clearSession).toHaveBeenCalledOnce()
  })

  it('records a failure identity once without merging distinct errors with the same message', () => {
    const latched: unknown[] = []
    const recorder = createApplicationFailureRecorder((error) => { latched.push(error) })
    const shared = new Error('same message')
    const distinct = new Error('same message')
    const consistency = new ProviderUsageConsistencyError()

    recorder.record(shared, 'database-close')
    recorder.record(shared, 'background-chat')
    recorder.record(distinct, 'execution-shutdown')
    recorder.record(consistency, 'video-background')
    recorder.record(consistency, 'video-stop')

    expect(recorder.select()).toEqual({ error: consistency })
    expect(latched).toEqual([consistency])

    const nonConsistency = createApplicationFailureRecorder(() => undefined)
    nonConsistency.record(shared, 'database-close')
    nonConsistency.record(shared, 'background-chat')
    nonConsistency.record(distinct, 'execution-shutdown')
    expect(nonConsistency.select()).toEqual({ error: distinct })

    const primitive = createApplicationFailureRecorder(() => undefined)
    primitive.record(undefined, 'database-close')
    primitive.record(undefined, 'background-chat')
    expect(primitive.select()).toEqual({ error: undefined })
  })

  it('returns a token usage snapshot across five local-calendar periods', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-token-usage-'))
    directories.push(root)
    const databasePath = join(root, 'autoforge.sqlite')
    const database = openAppDatabase(databasePath)
    database.localAuth.ensureExternalIdentity({ id: 'test_user_other', account: 'Other' }, 1)
    database.localAuth.ensureExternalIdentity({ id: 'test_user_usage', account: 'Usage' }, 2)
    database.conversations.insert({ id: 'usage_conversation', title: 'Usage' })
    database.chatRuns.insert({
      id: 'usage_run',
      conversationId: 'usage_conversation',
      requestId: 'usage_request',
      userId: 'test_user_usage',
      provider: 'openrouter',
      model: 'alpha/model',
      status: 'failed',
      startedAt: new Date(2026, 7, 17, 10).getTime(),
      inputTokens: 4,
      outputTokens: 6,
    })
    database.chatRuns.insert({
      id: 'other_usage_run',
      conversationId: 'usage_conversation',
      requestId: 'other_usage_request',
      userId: 'test_user_other',
      provider: 'deepseek',
      model: 'other/model',
      status: 'failed',
      startedAt: new Date(2026, 7, 17, 10).getTime(),
      inputTokens: 40,
      outputTokens: 60,
    })
    database.providerUsage.start({
      id: 'usage_cost',
      operationKey: 'usage_cost',
      userId: 'test_user_usage',
      provider: 'openrouter',
      requestId: 'usage_request',
      model: 'alpha/model',
      modality: 'text',
      startedAt: new Date(2026, 7, 17, 10).getTime(),
    })
    database.providerUsage.report('usage_cost', {
      costUsd: '0.25',
      endedAt: new Date(2026, 7, 17, 10, 1).getTime(),
    })
    database.providerUsage.start({
      id: 'other_usage_cost',
      operationKey: 'other_usage_cost',
      userId: 'test_user_other',
      provider: 'openrouter',
      requestId: 'other_usage_request',
      model: 'other/model',
      modality: 'text',
      startedAt: new Date(2026, 7, 17, 10).getTime(),
    })
    database.providerUsage.report('other_usage_cost', {
      costUsd: '9',
      endedAt: new Date(2026, 7, 17, 10, 1).getTime(),
    })
    database.close()

    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 17, 12))
    const runtime = createApplicationRuntime(options(root))
    try {
      await authenticate(runtime, 'Usage')
      const usage = await runtime.services.settings.getTokenUsage()

      expect(usage.generatedAt).toBe(new Date(2026, 7, 17, 12).toISOString())
      expect(usage.today).toMatchObject({
        startedAt: new Date(2026, 7, 17).toISOString(),
        inputTokens: 4,
        outputTokens: 6,
        totalTokens: 10,
        openRouterCostUsd: '0.25',
        openRouterKnownCostCount: 1,
        openRouterUnknownCostCount: 0,
        models: [{
          provider: 'openrouter',
          model: 'alpha/model',
          inputTokens: 4,
          outputTokens: 6,
          totalTokens: 10,
          openRouterCostUsd: '0.25',
          openRouterKnownCostCount: 1,
          openRouterUnknownCostCount: 0,
        }],
      })
      expect(usage.today.trend.reduce((sum, point) => sum + point.totalTokens, 0)).toBe(10)
      expect(usage.yesterday.totalTokens).toBe(0)
      expect(usage.week.totalTokens).toBe(10)
      expect(usage.month.totalTokens).toBe(10)
      expect(usage.allTime.totalTokens).toBe(10)
    } finally {
      await runtime.close()
      vi.useRealTimers()
    }
  })

  it('uses the injected auth service and keeps business gates on its session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-auth-'))
    directories.push(root)
    const authService = createTestAuthService()
    const runtime = createApplicationRuntime(options(root, { authService }))

    await expect(runtime.services.auth.requireSession())
      .rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    const session = await authenticate(runtime, 'Alice')
    expect(session.user.account).toBe('Alice')
    expect(runtime.services.auth).toMatchObject({
      getSession: expect.any(Function),
      sendOtp: expect.any(Function),
      verifyOtp: expect.any(Function),
      cancelOtp: expect.any(Function),
      loginWithPassword: expect.any(Function),
      logout: expect.any(Function),
      requireSession: expect.any(Function),
    })
    const sqlite = new Database(join(root, 'autoforge.sqlite'))
    expect(sqlite.prepare(`
      SELECT id, account, account_normalized AS accountNormalized
      FROM local_users
      WHERE id = ?
    `).get(session.user.id)).toEqual({
      id: session.user.id,
      account: 'Alice',
      accountNormalized: `cloudbase:${session.user.id}`,
    })
    expect(sqlite.prepare(`
      SELECT user_id AS userId, authenticated_at AS authenticatedAt
      FROM local_auth_session WHERE id = 1
    `).get()).toEqual({ userId: session.user.id, authenticatedAt: 0 })
    expect(sqlite.prepare(`
      SELECT user_id AS userId, birth_date AS birthDate
      FROM local_user_profiles WHERE user_id = ?
    `).get(session.user.id)).toEqual({ userId: session.user.id, birthDate: null })
    await runtime.services.auth.logout()
    await expect(runtime.services.auth.getSession()).resolves.toBeNull()
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM local_auth_session').get())
      .toEqual({ count: 0 })
    await expect(runtime.services.auth.loginWithPassword({
      account: 'Alice', password: 'password',
    })).resolves.toEqual(session)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM local_auth_session').get())
      .toEqual({ count: 1 })
    sqlite.prepare('DELETE FROM local_auth_session').run()
    await expect(runtime.services.auth.getSession()).resolves.toEqual(session)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM local_auth_session').get())
      .toEqual({ count: 1 })
    await runtime.services.auth.logout()
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM local_auth_session').get())
      .toEqual({ count: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM local_users WHERE id = ?')
      .get(session.user.id)).toEqual({ count: 1 })
    sqlite.close()
    await expect(runtime.services.settings.getTokenUsage())
      .rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    await runtime.close()
  })

  it('claims legacy conversations for the first user and isolates conversation lists by user', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-conversation-ownership-'))
    directories.push(root)
    const database = openAppDatabase(join(root, 'autoforge.sqlite'))
    database.conversations.insert({ id: 'legacy_conversation', title: 'Legacy' })
    database.close()
    const runtime = createApplicationRuntime(options(root))

    const alice = await authenticate(runtime, 'Alice')
    expect(await runtime.services.chat.listConversations()).toEqual([
      expect.objectContaining({ id: 'legacy_conversation' }),
    ])
    const aliceConversation = await runtime.services.chat.createConversation()
    expect(await runtime.services.chat.renameConversation(aliceConversation.id, 'Alice conversation'))
      .not.toHaveProperty('userId')

    await runtime.services.auth.logout()
    await authenticate(runtime, 'Bobby')
    expect(await runtime.services.chat.listConversations()).toEqual([])
    const bobConversation = await runtime.services.chat.createConversation()
    expect(await runtime.services.chat.listConversations()).toEqual([
      expect.objectContaining({ id: bobConversation.id }),
    ])

    await runtime.services.auth.logout()
    await runtime.services.auth.loginWithPassword({ account: 'Alice', password: 'password' })
    expect(await runtime.services.chat.listConversations()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'legacy_conversation' }),
      expect.objectContaining({ id: aliceConversation.id }),
    ]))
    expect(await runtime.services.chat.listConversations()).toHaveLength(2)

    const inspection = new Database(join(root, 'autoforge.sqlite'), { readonly: true })
    expect(inspection.prepare('SELECT user_id AS userId FROM conversations WHERE id = ?')
      .get('legacy_conversation')).toEqual({ userId: alice.user.id })
    inspection.close()
    await runtime.close()
  })

  it('rejects cross-user access to conversation operations without revealing existence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-conversation-access-'))
    directories.push(root)
    const runtime = createApplicationRuntime(options(root))
    await authenticate(runtime, 'Alice')
    const conversation = await runtime.services.chat.createConversation()
    await runtime.services.auth.logout()
    await authenticate(runtime, 'Bobby')

    const preferences = {
      outputType: 'auto' as const,
      models: {},
      generation: {
        image: { count: 1 as const, resolution: '1K', aspectRatio: 'auto', format: 'png' },
        audio: { format: 'mp3' },
        video: { durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false },
      },
    }
    for (const operation of [
      () => runtime.services.chat.listMessages(conversation.id),
      () => runtime.services.chat.getGenerationPreferences(conversation.id),
      () => runtime.services.chat.updateGenerationPreferences(conversation.id, preferences),
      () => runtime.services.chat.send(chatInput(conversation.id, 'not mine')),
      () => runtime.services.chat.renameConversation(conversation.id, 'Stolen'),
      () => runtime.services.chat.deleteConversation(conversation.id),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }

    await runtime.services.auth.logout()
    await runtime.services.auth.loginWithPassword({ account: 'Alice', password: 'password' })
    expect(await runtime.services.chat.listConversations()).toEqual([
      expect.objectContaining({ id: conversation.id, title: '新会话' }),
    ])
    await runtime.close()
  })

  it('rejects cross-user cancellation by request id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-conversation-cancel-owner-'))
    directories.push(root)
    const emitChat = vi.fn()
    const runtime = createApplicationRuntime(options(root, {
      modelProviders: snapshotProviders({ openrouter: {
        listModels: async () => [modelInfo('openrouter/text', 'OpenRouter text')],
        validateCredential: async () => ({ valid: true }),
        stream: async function* () {
          yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
        },
      } }),
      emitChat,
    }))
    await authenticate(runtime, 'Alice')
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    const current = await runtime.services.settings.get()
    await runtime.services.settings.update({
      activeProvider: 'openrouter',
      defaultModels: { ...current.defaultModels, openrouter: { text: 'openrouter/text' } },
    })
    const conversation = await runtime.services.chat.createConversation()
    const { requestId } = await runtime.services.chat.send(chatInput(conversation.id, 'Alice request'))
    await vi.waitFor(() => expect(emitChat).toHaveBeenCalledWith(expect.objectContaining({
      type: 'status', requestId, status: 'completed',
    })))

    await runtime.services.auth.logout()
    await authenticate(runtime, 'Bobby')
    await expect(runtime.services.chat.cancel(requestId))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
    await runtime.close()
  })

  it('rejects cross-user media imports before processing empty input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-conversation-media-owner-'))
    directories.push(root)
    const runtime = createApplicationRuntime(options(root))
    await authenticate(runtime, 'Alice')
    const conversation = await runtime.services.chat.createConversation()
    await runtime.services.auth.logout()
    await authenticate(runtime, 'Bobby')
    const context = { conversationId: conversation.id, existingAssetIds: [] }

    for (const operation of [
      () => runtime.services.media.pickFiles(context),
      () => runtime.services.media.importDroppedFiles({ ...context, paths: [] }),
      () => runtime.services.media.importClipboardImage(context),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }
    await runtime.close()
  })

  it('rejects protocol media resolution and asset actions outside the owning user session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-media-protocol-owner-'))
    directories.push(root)
    const source = join(root, 'alice.png')
    await writeFile(source, Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      Buffer.from('alice-private-media'),
    ]))
    const runtime = createApplicationRuntime(options(root, {
      chooseMediaFiles: async () => [source],
    }))
    await authenticate(runtime, 'Alice')
    const conversation = await runtime.services.chat.createConversation()
    const [asset] = await runtime.services.media.pickFiles({
      conversationId: conversation.id,
      existingAssetIds: [],
    })
    await expect(runtime.mediaAssets.resolveReadyAsset(asset!.id))
      .resolves.toMatchObject({ name: 'alice.png' })

    await runtime.services.auth.logout()
    await expect(runtime.mediaAssets.resolveReadyAsset(asset!.id))
      .rejects.toMatchObject({ code: 'AUTH_REQUIRED' })

    await authenticate(runtime, 'Bobby')
    for (const operation of [
      () => runtime.mediaAssets.resolveReadyAsset(asset!.id),
      () => runtime.services.media.removeDraft({ conversationId: conversation.id, assetId: asset!.id }),
      () => runtime.services.media.saveCopy(asset!.id),
      () => runtime.services.media.reveal(asset!.id),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }
    await runtime.close()
  })

  it('maps an external identity projection failure to a safe application error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-auth-projection-error-'))
    directories.push(root)
    const database = openAppDatabase(join(root, 'autoforge.sqlite'))
    database.localAuth.createUserAndSession({
      id: 'test_user_alice', account: 'LegacyAlice', accountNormalized: 'legacyalice',
      passwordDigest: 'legacy-digest', createdAt: 1, updatedAt: 1,
    }, 1)
    database.localAuth.clearSession()
    database.close()
    const authService = createTestAuthService()
    const discardSession = vi.spyOn(authService, 'discardSession')
    const runtime = createApplicationRuntime(options(root, { authService }))

    await expect(authenticate(runtime, 'Alice'))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(discardSession).toHaveBeenCalledOnce()
    await expect(runtime.services.auth.getSession()).resolves.toBeNull()
    await runtime.close()
  })

  it('retains the projected local session when CloudBase logout fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-auth-logout-error-'))
    directories.push(root)
    const authService = createTestAuthService()
    const runtime = createApplicationRuntime(options(root, { authService }))
    const session = await authenticate(runtime, 'Alice')
    vi.spyOn(authService, 'logout').mockRejectedValueOnce(toSafeAppError({ code: 'INTERNAL_ERROR' }))

    await expect(runtime.services.auth.logout()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })

    const sqlite = new Database(join(root, 'autoforge.sqlite'), { readonly: true })
    expect(sqlite.prepare('SELECT user_id AS userId FROM local_auth_session WHERE id = 1').get())
      .toEqual({ userId: session.user.id })
    sqlite.close()
    await runtime.close()
  })

  it('persists the authenticated user profile across runtime restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-profile-'))
    directories.push(root)
    const runtimeOptions = options(root, {
      qiniuEnv: {},
      chooseAvatarFile: async () => undefined,
    })
    const runtime = createApplicationRuntime(runtimeOptions)
    await authenticate(runtime, 'Alice')

    await expect(runtime.services.profile.update({ displayName: 'Alice Zhang' })).resolves.toMatchObject({
      userId: expect.any(String), account: 'Alice', displayName: 'Alice Zhang',
    })
    await runtime.close()

    const restarted = createApplicationRuntime(runtimeOptions)
    await expect(restarted.services.profile.get()).resolves.toMatchObject({
      account: 'Alice', displayName: 'Alice Zhang',
    })
    await restarted.close()
  })

  it('forwards chat events only while a local session is authenticated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-auth-events-'))
    directories.push(root)
    const emitChat = vi.fn()
    const runtime = createApplicationRuntime(options(root, {
      modelProviders: snapshotProviders({ openrouter: {
        listModels: async () => [modelInfo('openrouter/text', 'OpenRouter text')],
        validateCredential: async () => ({ valid: true }),
        stream: async function* () {
          yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
        },
      } }),
      emitChat,
    }))
    await authenticate(runtime, 'Alice')
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    const current = await runtime.services.settings.get()
    await runtime.services.settings.update({
      activeProvider: 'openrouter',
      defaultModels: { ...current.defaultModels, openrouter: { text: 'openrouter/text' } },
    })
    const conversation = await runtime.services.chat.createConversation()
    const settleEvents = async () => {
      for (let index = 0; index < 5; index += 1) {
        await new Promise<void>((resolve) => { setImmediate(resolve) })
      }
    }

    await runtime.services.auth.logout()
    await expect(runtime.services.chat.send(chatInput(conversation.id, 'anonymous')))
      .rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    await expect(runtime.services.chat.listMessages(conversation.id))
      .rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(emitChat).not.toHaveBeenCalled()

    await runtime.services.auth.loginWithPassword({ account: 'Alice', password: 'password' })
    const authenticated = await runtime.services.chat.send(chatInput(conversation.id, 'authenticated'))
    await vi.waitFor(() => expect(emitChat.mock.calls.some(([event]) => (
      event.type === 'status'
      && event.requestId === authenticated.requestId
      && event.status === 'completed'
    ))).toBe(true))

    await runtime.services.auth.logout()
    const forwardedCount = emitChat.mock.calls.length
    await expect(runtime.services.chat.send(chatInput(conversation.id, 'logged out')))
      .rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    await settleEvents()
    await expect(runtime.services.chat.listMessages(conversation.id))
      .rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(emitChat).toHaveBeenCalledTimes(forwardedCount)
    await runtime.services.auth.loginWithPassword({ account: 'Alice', password: 'password' })
    expect(await runtime.services.chat.listMessages(conversation.id)).toHaveLength(2)
    await runtime.close()
  })

  it('does not forward a previous user conversation events after the active user changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-user-event-isolation-'))
    directories.push(root)
    const streamStarted = deferred<void>()
    const releaseStream = deferred<void>()
    const emitChat = vi.fn()
    const runtime = createApplicationRuntime(options(root, {
      modelProviders: snapshotProviders({ openrouter: {
        listModels: async () => [modelInfo('openrouter/text', 'OpenRouter text')],
        validateCredential: async () => ({ valid: true }),
        stream: async function* () {
          streamStarted.resolve()
          await releaseStream.promise
          yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
        },
      } }),
      emitChat,
    }))
    await authenticate(runtime, 'Alice')
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    const current = await runtime.services.settings.get()
    await runtime.services.settings.update({
      activeProvider: 'openrouter',
      defaultModels: { ...current.defaultModels, openrouter: { text: 'openrouter/text' } },
    })
    const conversation = await runtime.services.chat.createConversation()
    await runtime.services.chat.send(chatInput(conversation.id, 'Alice request'))
    await streamStarted.promise

    await runtime.services.auth.logout()
    await authenticate(runtime, 'Bobby')
    emitChat.mockClear()
    releaseStream.resolve()
    for (let index = 0; index < 10; index += 1) {
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    }

    expect(emitChat).not.toHaveBeenCalled()
    await runtime.close()
  })

  it('captures the authenticated user before route resolution and persists only the OpenRouter key fingerprint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-usage-owner-'))
    directories.push(root)
    const catalog = deferred<ModelInfo[]>()
    const emitChat = vi.fn()
    const openrouter = {
      listModels: vi.fn(() => catalog.promise),
      validateCredential: vi.fn(async () => ({ valid: true })),
      stream: vi.fn(async function* (request: ModelStreamRequest) {
        expect(request.endUserId).toBeDefined()
        yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
      }),
    }
    const deepseek = {
      listModels: vi.fn(async () => [modelInfo('deepseek-v4-flash', 'DeepSeek')]),
      validateCredential: vi.fn(async () => ({ valid: true })),
      stream: vi.fn(async function* () {
        yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
      }),
    }
    const getSecret = vi.spyOn(SecretStore.prototype, 'get')
    const runtime = createApplicationRuntime(options(root, {
      modelProviders: snapshotProviders({ openrouter, deepseek }),
      emitChat,
    }))
    const alice = await authenticate(runtime, 'Alice')
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter-user-a')
    await runtime.services.settings.saveProviderApiKey('deepseek', 'sk-deepseek-user-b')
    await runtime.services.settings.update({
      activeProvider: 'openrouter',
      defaultModels: {
        deepseek: { text: 'deepseek-v4-flash' },
        openrouter: { text: 'openai/gpt-4.1-mini' },
      },
    })
    const openRouterConversation = await runtime.services.chat.createConversation()

    const sending = runtime.services.chat.send(chatInput(openRouterConversation.id, 'owned by Alice'))
    await vi.waitFor(() => expect(openrouter.listModels).toHaveBeenCalledTimes(1))
    await runtime.services.auth.logout()
    const bob = await authenticate(runtime, 'Bobby')
    catalog.resolve([modelInfo('openai/gpt-4.1-mini', 'OpenRouter')])
    const openRouterRequest = await sending
    await vi.waitFor(() => {
      const inspection = new Database(join(root, 'autoforge.sqlite'), { readonly: true })
      const run = inspection.prepare('SELECT status FROM chat_runs WHERE request_id = ?')
        .get(openRouterRequest.requestId)
      inspection.close()
      expect(run).toEqual({ status: 'completed' })
    })

    await runtime.services.settings.update({ activeProvider: 'deepseek' })
    const deepSeekConversation = await runtime.services.chat.createConversation()
    const deepSeekRequest = await runtime.services.chat.send(chatInput(deepSeekConversation.id, 'owned by Bob'))
    await vi.waitFor(() => expect(emitChat).toHaveBeenCalledWith(expect.objectContaining({
      type: 'status', requestId: deepSeekRequest.requestId, status: 'completed',
    })))
    await runtime.close()

    const sqlite = new Database(join(root, 'autoforge.sqlite'), { readonly: true })
    try {
      const runs = sqlite.prepare(`
        SELECT request_id AS requestId, user_id AS userId, provider
        FROM chat_runs
      `).all()
      expect(runs).toHaveLength(2)
      expect(runs).toEqual(expect.arrayContaining([
        { requestId: openRouterRequest.requestId, userId: alice.user.id, provider: 'openrouter' },
        { requestId: deepSeekRequest.requestId, userId: bob.user.id, provider: 'deepseek' },
      ]))
      const usage = sqlite.prepare(`
        SELECT user_id AS userId, api_key_fingerprint AS apiKeyFingerprint
        FROM provider_usage_events
      `).get()
      expect(usage).toEqual({
        userId: alice.user.id,
        apiKeyFingerprint: 'fingerprint_test',
      })
      expect(JSON.stringify(usage)).not.toContain('sk-openrouter-user-a')
    } finally {
      sqlite.close()
    }
    expect(getSecret).not.toHaveBeenCalled()
    expect(openrouter.stream).toHaveBeenCalledWith(expect.objectContaining({ endUserId: alice.user.id }))
    expect(deepseek.stream).toHaveBeenCalledWith(expect.objectContaining({ endUserId: bob.user.id }))
  })

  it('keeps one real OpenRouter credential snapshot through validation, catalog, summary, and model usage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-provider-snapshot-'))
    directories.push(root)
    const proxy = createNetworkProxy()
    const requests: Array<{ url: string; authorization: string }> = []
    let switched = false
    let chatCalls = 0
    proxy.fetch.mockImplementation(async (input, init) => {
      const url = String(input)
      requests.push({
        url,
        authorization: new Headers(init?.headers).get('authorization') ?? '',
      })
      if (!switched) {
        switched = true
        await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter-b')
      }
      if (url.endsWith('/chat/completions')) {
        chatCalls += 1
        const cost = chatCalls === 1 ? 0.01 : 0.02
        return new Response([
          `data: ${JSON.stringify({ id: `generation_${chatCalls}`, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, cost } })}`,
          'data: [DONE]',
          '',
        ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } })
      }
      if (url.endsWith('/models')) {
        return Response.json({ data: [{
          id: 'openai/gpt-4.1-mini',
          name: 'OpenRouter text',
          supported_parameters: [],
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        }] })
      }
      return Response.json({ data: [] })
    })
    const emitChat = vi.fn()
    const runtime = createApplicationRuntime(options(root, { networkProxy: proxy, emitChat }))
    const session = await authenticate(runtime, 'SnapshotUser')
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter-a')
    await runtime.services.settings.update({
      activeProvider: 'openrouter',
      defaultModels: {
        deepseek: { text: 'deepseek-v4-flash' },
        openrouter: { text: 'openai/gpt-4.1-mini' },
      },
    })

    const firstConversation = await runtime.services.chat.createConversation()
    const first = await runtime.services.chat.send(chatInput(firstConversation.id, 'first'))
    await vi.waitFor(() => expect(emitChat).toHaveBeenCalledWith(expect.objectContaining({
      type: 'status', requestId: first.requestId, status: 'completed',
    })))
    const secondConversation = await runtime.services.chat.createConversation()
    const second = await runtime.services.chat.send(chatInput(secondConversation.id, 'second'))
    await vi.waitFor(() => expect(emitChat).toHaveBeenCalledWith(expect.objectContaining({
      type: 'status', requestId: second.requestId, status: 'completed',
    })))

    const chatRequests = requests.filter(({ url }) => url.endsWith('/chat/completions'))
    expect(chatRequests.map(({ authorization }) => authorization)).toEqual([
      'Bearer sk-openrouter-a',
      'Bearer sk-openrouter-b',
    ])
    const catalogAuthorizations = requests
      .filter(({ url }) => url.includes('/models'))
      .map(({ authorization }) => authorization)
    expect(catalogAuthorizations).toContain('Bearer sk-openrouter-a')
    expect(catalogAuthorizations).toContain('Bearer sk-openrouter-b')
    const usage = await runtime.services.settings.getTokenUsage()
    expect(usage.allTime).toMatchObject({
      openRouterCostUsd: '0.03',
      openRouterKnownCostCount: 2,
      openRouterUnknownCostCount: 0,
    })
    expect(usage.allTime.models).toContainEqual(expect.objectContaining({
      provider: 'openrouter',
      model: 'openai/gpt-4.1-mini',
      openRouterCostUsd: '0.03',
    }))
    await runtime.close()

    const sqlite = new Database(join(root, 'autoforge.sqlite'), { readonly: true })
    try {
      expect(sqlite.prepare(`
        SELECT user_id AS userId, api_key_fingerprint AS apiKeyFingerprint, cost_usd AS costUsd
        FROM provider_usage_events ORDER BY started_at, operation_key
      `).all()).toEqual([
        { userId: session.user.id, apiKeyFingerprint: fingerprintApiKey('sk-openrouter-a'), costUsd: '0.01' },
        { userId: session.user.id, apiKeyFingerprint: fingerprintApiKey('sk-openrouter-b'), costUsd: '0.02' },
      ])
    } finally {
      sqlite.close()
    }
  })

  it.each([
    ['text', 'run', modelInfo('openai/gpt-4.1-mini', 'Text')],
    ['image', 'runImage', imageModelInfo('openrouter/image')],
    ['audio', 'runAudio', audioModelInfo('openrouter/audio')],
  ] as const)('latches an unexpected %s consistency rejection, refuses new work, and rethrows the original error on close', async (outputType, method, model) => {
    const root = await mkdtemp(join(tmpdir(), `autoforge-application-${outputType}-latch-`))
    directories.push(root)
    const consistencyError = new ProviderUsageConsistencyError()
    const operationSpy = method === 'run'
      ? vi.spyOn(AgentOrchestrator.prototype, 'run').mockRejectedValueOnce(consistencyError)
      : method === 'runImage'
        ? vi.spyOn(MediaGenerationOrchestrator.prototype, 'runImage').mockRejectedValueOnce(consistencyError)
        : vi.spyOn(MediaGenerationOrchestrator.prototype, 'runAudio').mockRejectedValueOnce(consistencyError)
    const provider = snapshotProvider('openrouter', {
      listModels: vi.fn(async () => [model]),
      validateCredential: vi.fn(async () => ({ valid: true })),
      stream: vi.fn(async function* () { yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' } }),
      generateImage: vi.fn(async () => ({ outputs: [] })),
    })
    const runtime = createApplicationRuntime(options(root, {
      modelProviders: { openrouter: provider },
    }))
    await authenticate(runtime)
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.update({
      activeProvider: 'openrouter',
      defaultModels: {
        deepseek: { text: 'deepseek-v4-flash' },
        openrouter: outputType === 'text'
          ? { text: model.id }
          : outputType === 'image' ? { image: model.id } : { audio: model.id },
      },
    })
    const conversation = await runtime.services.chat.createConversation()

    await runtime.services.chat.send({ ...chatInput(conversation.id, 'fail'), outputType })
    await vi.waitFor(() => expect(operationSpy).toHaveBeenCalled())
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    await expect(runtime.services.chat.send({ ...chatInput(conversation.id, 'refused'), outputType }))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(runtime.close()).rejects.toBe(consistencyError)
  })

  it('latches a real preflight snapshot provider mismatch before model work starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-preflight-consistency-'))
    directories.push(root)
    const bound = snapshotProvider('openrouter', {
      listModels: vi.fn(async () => [modelInfo('openrouter/text', 'Text')]),
      validateCredential: vi.fn(async () => ({ valid: true })),
      stream: vi.fn(async function* () {
        yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
      }),
    })
    const mismatched: CredentialBoundModelProvider = {
      ...bound,
      acquireSnapshot: vi.fn(async () => ({ providerId: 'deepseek' as const, provider: bound })),
    }
    const runtime = createApplicationRuntime(options(root, {
      modelProviders: { openrouter: mismatched },
    }))
    await authenticate(runtime)
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.update({ activeProvider: 'openrouter' })
    const conversation = await runtime.services.chat.createConversation()

    let consistencyError: unknown
    try {
      await runtime.services.chat.send(chatInput(conversation.id, 'mismatch'))
    } catch (error) {
      consistencyError = error
    }
    expect(consistencyError).toBeInstanceOf(ProviderUsageConsistencyError)
    await expect(runtime.services.chat.send(chatInput(conversation.id, 'refused')))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(runtime.close()).rejects.toBe(consistencyError)
  })

  it('latches and rethrows a video submit consistency rejection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-video-submit-consistency-'))
    directories.push(root)
    const consistencyError = new ProviderUsageConsistencyError()
    vi.spyOn(VideoJobRunner.prototype, 'submit').mockRejectedValueOnce(consistencyError)
    const provider = snapshotProvider('openrouter', {
      listModels: vi.fn(async () => [videoModelInfo('openrouter/video')]),
      validateCredential: vi.fn(async () => ({ valid: true })),
      stream: vi.fn(async function* () {
        yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
      }),
      submitVideo: vi.fn(async () => ({ providerJobId: 'provider_video', status: 'pending' as const })),
    })
    const runtime = createApplicationRuntime(options(root, {
      modelProviders: { openrouter: provider },
    }))
    await authenticate(runtime)
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.update({
      activeProvider: 'openrouter',
      defaultModels: {
        deepseek: { text: 'deepseek-v4-flash' },
        openrouter: { video: 'openrouter/video' },
      },
    })
    const conversation = await runtime.services.chat.createConversation()

    await expect(runtime.services.chat.send({
      ...chatInput(conversation.id, 'video'),
      outputType: 'video',
    })).rejects.toBe(consistencyError)
    await expect(runtime.services.chat.send(chatInput(conversation.id, 'refused')))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(runtime.close()).rejects.toBe(consistencyError)
  })

  it('latches a real timer-started video consistency failure before shutdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-video-background-consistency-'))
    directories.push(root)
    const databasePath = join(root, 'autoforge.sqlite')
    const videoStop = vi.spyOn(VideoJobRunner.prototype, 'stop')
    const provider = snapshotProvider('openrouter', {
      listModels: vi.fn(async () => [videoModelInfo('openrouter/video')]),
      validateCredential: vi.fn(async () => ({ valid: true })),
      stream: vi.fn(async function* () {
        yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
      }),
      submitVideo: vi.fn(async () => ({ providerJobId: 'provider_video', status: 'pending' as const })),
      pollVideo: vi.fn(async () => ({ status: 'in_progress' as const })),
    })
    const runtime = createApplicationRuntime(options(root, {
      modelProviders: { openrouter: provider },
    }))
    await authenticate(runtime)
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.update({
      activeProvider: 'openrouter',
      defaultModels: {
        deepseek: { text: 'deepseek-v4-flash' },
        openrouter: { video: 'openrouter/video' },
      },
    })
    const conversation = await runtime.services.chat.createConversation()
    vi.useFakeTimers()
    try {
      const { requestId } = await runtime.services.chat.send({
        ...chatInput(conversation.id, 'video'),
        outputType: 'video',
      })
      const tamper = new Database(databasePath)
      try {
        expect(tamper.prepare('DELETE FROM provider_usage_events WHERE operation_key = ?')
          .run(`video:${requestId}`).changes).toBe(1)
      } finally {
        tamper.close()
      }

      await vi.advanceTimersByTimeAsync(2_000)
      await expect(runtime.services.chat.send(chatInput(conversation.id, 'refused')))
        .rejects.toMatchObject({ code: 'CONFLICT' })
      let closeError: unknown
      try {
        await runtime.close()
      } catch (error) {
        closeError = error
      }
      expect(closeError).toBeInstanceOf(ProviderUsageConsistencyError)
      expect(videoStop).toHaveBeenCalledTimes(1)
      await expect(videoStop.mock.results[0]!.value).rejects.toBe(closeError)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not latch an orchestrator business-failure result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-business-failure-'))
    directories.push(root)
    vi.spyOn(AgentOrchestrator.prototype, 'run').mockResolvedValue({
      requestId: 'business_failure',
      status: 'failed',
      error: toSafeAppError({ code: 'MODEL_PROVIDER_REQUEST_FAILED' }),
    })
    const provider = snapshotProvider('openrouter', {
      listModels: vi.fn(async () => [modelInfo('openai/gpt-4.1-mini', 'Text')]),
      validateCredential: vi.fn(async () => ({ valid: true })),
      stream: vi.fn(async function* () { yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' } }),
    })
    const runtime = createApplicationRuntime(options(root, { modelProviders: { openrouter: provider } }))
    await authenticate(runtime)
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.update({ activeProvider: 'openrouter' })
    const first = await runtime.services.chat.createConversation()
    const second = await runtime.services.chat.createConversation()

    await expect(runtime.services.chat.send(chatInput(first.id, 'first'))).resolves.toHaveProperty('requestId')
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    await expect(runtime.services.chat.send(chatInput(second.id, 'second'))).resolves.toHaveProperty('requestId')
    await expect(runtime.close()).resolves.toBeUndefined()
  })

  it('keeps an awaiting approval request active so close cancels and terminalizes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-awaiting-close-'))
    directories.push(root)
    const chatEvents: ChatEvent[] = []
    let workflowId = ''
    const provider = snapshotProvider('openrouter', {
      listModels: vi.fn(async () => [{
        ...modelInfo('openrouter/tools', 'Tools'),
        supportsTools: true,
      }]),
      validateCredential: vi.fn(async () => ({ valid: true })),
      stream: vi.fn(async function* () {
        yield {
          type: 'tool_call' as const,
          choiceIndex: 0,
          index: 0,
          id: 'call_approval',
          name: workflowId,
          arguments: {},
        }
        yield { type: 'finish' as const, choiceIndex: 0, reason: 'tool_calls' }
      }),
    })
    const runtime = createApplicationRuntime(options(root, {
      modelProviders: { openrouter: provider },
      emitChat: (event) => { chatEvents.push(event) },
    }))
    await authenticate(runtime)
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.update({
      activeProvider: 'openrouter',
      defaultModels: {
        deepseek: { text: 'deepseek-v4-flash' },
        openrouter: { text: 'openrouter/tools' },
      },
    })
    workflowId = (await installApprovalWorkflow(runtime)).id
    const conversation = await runtime.services.chat.createConversation()

    const { requestId } = await runtime.services.chat.send(chatInput(conversation.id, 'approval workflow'))
    await vi.waitFor(() => expect(chatEvents).toContainEqual(expect.objectContaining({
      type: 'block',
      block: expect.objectContaining({ type: 'approval' }),
    })))

    await runtime.close()

    const database = openAppDatabase(join(root, 'autoforge.sqlite'))
    try {
      expect(database.chatRuns.getByRequestId(requestId)).toMatchObject({
        status: 'cancelled',
        errorCode: 'CANCELLED',
        endedAt: expect.any(Number),
      })
    } finally {
      database.close()
    }
  })

  it('latches and rethrows the exact consistency failure from approval resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-awaiting-resume-'))
    directories.push(root)
    const chatEvents: ChatEvent[] = []
    let workflowId = ''
    const provider = snapshotProvider('openrouter', {
      listModels: vi.fn(async () => [{
        ...modelInfo('openrouter/tools', 'Tools'),
        supportsTools: true,
      }]),
      validateCredential: vi.fn(async () => ({ valid: true })),
      stream: vi.fn(async function* () {
        yield {
          type: 'tool_call' as const,
          choiceIndex: 0,
          index: 0,
          id: 'call_approval',
          name: workflowId,
          arguments: {},
        }
        yield { type: 'finish' as const, choiceIndex: 0, reason: 'tool_calls' }
      }),
    })
    const runtime = createApplicationRuntime(options(root, {
      modelProviders: { openrouter: provider },
      emitChat: (event) => { chatEvents.push(event) },
    }))
    await authenticate(runtime)
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.update({
      activeProvider: 'openrouter',
      defaultModels: {
        deepseek: { text: 'deepseek-v4-flash' },
        openrouter: { text: 'openrouter/tools' },
      },
    })
    workflowId = (await installApprovalWorkflow(runtime)).id
    const conversation = await runtime.services.chat.createConversation()

    await runtime.services.chat.send(chatInput(conversation.id, 'approval workflow'))
    await vi.waitFor(() => expect(chatEvents).toContainEqual(expect.objectContaining({
      type: 'block', block: expect.objectContaining({ type: 'approval' }),
    })))
    const approval = chatEvents.find((event): event is Extract<ChatEvent, { type: 'block' }> => (
      event.type === 'block' && event.block.type === 'approval'
    ))!.block as Extract<Extract<ChatEvent, { type: 'block' }>['block'], { type: 'approval' }>
    const consistencyError = new ProviderUsageConsistencyError()
    vi.spyOn(AgentOrchestrator.prototype, 'resumeApproval').mockRejectedValueOnce(consistencyError)

    await expect(runtime.services.executions.decide({
      executionId: approval.executionId,
      permissionIndex: approval.permissionIndex,
      scopeHash: approval.scopeHash,
      decision: 'once',
    })).rejects.toBe(consistencyError)
    await expect(runtime.services.chat.send(chatInput(conversation.id, 'refused')))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(runtime.close()).rejects.toBe(consistencyError)
  })

  it('gives a latched consistency error priority over later shutdown failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-consistency-priority-'))
    directories.push(root)
    const consistencyError = new ProviderUsageConsistencyError()
    const laterConsistencyError = new ProviderUsageConsistencyError()
    vi.spyOn(AgentOrchestrator.prototype, 'run').mockRejectedValueOnce(consistencyError)
    vi.spyOn(VideoJobRunner.prototype, 'stop').mockRejectedValueOnce(laterConsistencyError)
    vi.spyOn(ExecutionService.prototype, 'shutdown').mockRejectedValueOnce(new Error('execution shutdown'))
    const provider = snapshotProvider('openrouter', {
      listModels: vi.fn(async () => [modelInfo('openai/gpt-4.1-mini', 'Text')]),
      validateCredential: vi.fn(async () => ({ valid: true })),
      stream: vi.fn(async function* () { yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' } }),
    })
    const runtime = createApplicationRuntime(options(root, { modelProviders: { openrouter: provider } }))
    await authenticate(runtime)
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.update({ activeProvider: 'openrouter' })
    const conversation = await runtime.services.chat.createConversation()
    await runtime.services.chat.send(chatInput(conversation.id, 'fail consistently'))
    await new Promise<void>((resolve) => { setImmediate(resolve) })

    await expect(runtime.close()).rejects.toBe(consistencyError)
  })

  it('continues cleanup after synchronous cancellation throws and applies stable failure priority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-sync-cancel-'))
    directories.push(root)
    const agentError = new Error('agent cancel synchronously failed')
    const mediaError = new Error('media cancel synchronously failed')
    vi.spyOn(AgentOrchestrator.prototype, 'run').mockResolvedValueOnce({
      requestId: 'awaiting',
      status: 'awaiting_approval',
      executionId: 'execution_awaiting',
    })
    const agentCancel = vi.spyOn(AgentOrchestrator.prototype, 'cancel').mockImplementation(() => {
      throw agentError
    })
    const mediaCancel = vi.spyOn(MediaGenerationOrchestrator.prototype, 'cancel').mockImplementation(() => {
      throw mediaError
    })
    const executionShutdown = vi.spyOn(ExecutionService.prototype, 'shutdown')
    const databaseClose = vi.spyOn(Database.prototype, 'close')
    const provider = snapshotProvider('openrouter', {
      listModels: vi.fn(async () => [modelInfo('openrouter/text', 'Text')]),
      validateCredential: vi.fn(async () => ({ valid: true })),
      stream: vi.fn(async function* () {
        yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
      }),
    })
    const runtime = createApplicationRuntime(options(root, {
      modelProviders: { openrouter: provider },
    }))
    await authenticate(runtime)
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.update({
      activeProvider: 'openrouter',
      defaultModels: {
        deepseek: { text: 'deepseek-v4-flash' },
        openrouter: { text: 'openrouter/text' },
      },
    })
    const conversation = await runtime.services.chat.createConversation()
    await runtime.services.chat.send(chatInput(conversation.id, 'await approval'))
    await vi.waitFor(() => expect(AgentOrchestrator.prototype.run).toHaveBeenCalled())

    await expect(runtime.close()).rejects.toBe(agentError)
    expect(agentCancel).toHaveBeenCalledTimes(1)
    expect(mediaCancel).toHaveBeenCalledTimes(1)
    expect(executionShutdown).toHaveBeenCalledTimes(1)
    expect(databaseClose).toHaveBeenCalledTimes(1)
  })

  it('memoizes close and rejects recover after shutdown starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-close-memo-'))
    directories.push(root)
    const runtime = createApplicationRuntime(options(root))

    const first = runtime.close()
    const second = runtime.close()

    expect(second).toBe(first)
    await expect(first).resolves.toBeUndefined()
    expect(runtime.close()).toBe(first)
    await expect(runtime.recover()).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('runs interrupted usage recovery without blocking startup and preserves the failure for close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-usage-recovery-'))
    directories.push(root)
    const interrupted = deferred<void>()
    vi.spyOn(ProviderUsageReconciler.prototype, 'recoverInterrupted')
      .mockImplementationOnce(() => interrupted.promise)
    const recoveryError = new Error('sk-sensitive-recovery-key')
    const runtime = createApplicationRuntime(options(root))

    await expect(runtime.recover()).resolves.toBeUndefined()
    expect(recoveryProbe).toHaveBeenCalledTimes(1)
    interrupted.reject(recoveryError)
    await expect(runtime.close()).rejects.toBe(recoveryError)
  })

  it('recovers pending usage locally without consuming retries when OpenRouter lacks generation usage capability', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-usage-capability-'))
    directories.push(root)
    const databasePath = join(root, 'autoforge.sqlite')
    const database = openAppDatabase(databasePath)
    database.localAuth.createUserAndSession({
      id: 'user_capability', account: 'Capability', accountNormalized: 'capability',
      passwordDigest: 'digest-capability', createdAt: 1, updatedAt: 1,
    }, 1)
    const usage = (id: string, startedAt: number) => ({
      id,
      operationKey: `operation_${id}`,
      userId: 'user_capability',
      provider: 'openrouter' as const,
      apiKeyFingerprint: '9990f372dd37cc8754019a4215e0dedc4ec55fd78e0b7e38ad73c7e152a9986c',
      requestId: `request_${id}`,
      model: 'openrouter/model',
      modality: 'text' as const,
      startedAt,
    })
    database.providerUsage.start(usage('unknown', 100))
    database.providerUsage.bindIdentity('operation_unknown', { generationId: 'generation_unknown' })
    database.providerUsage.markUnknown('operation_unknown', 100)
    database.providerUsage.start(usage('pending', 200))
    database.providerUsage.bindIdentity('operation_pending', { generationId: 'generation_pending' })
    database.close()

    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const runtime = createApplicationRuntime(options(root, {
      modelProviders: snapshotProviders({ openrouter: {
        listModels: async () => [],
        validateCredential: async () => ({ valid: true }),
        stream: async function* () {
          yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
        },
      } }),
    }))
    try {
      await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-capability')
      await runtime.recover()
      await vi.advanceTimersByTimeAsync(100_000)
      await runtime.close()
    } finally {
      vi.useRealTimers()
    }

    const sqlite = new Database(databasePath, { readonly: true })
    try {
      expect(sqlite.prepare(`
        SELECT operation_key AS operationKey, status, reconcile_attempts AS reconcileAttempts,
               next_reconcile_at AS nextReconcileAt, ended_at AS endedAt
        FROM provider_usage_events
        ORDER BY operation_key
      `).all()).toEqual([
        {
          operationKey: 'operation_pending', status: 'unknown', reconcileAttempts: 0,
          nextReconcileAt: 11_000, endedAt: 10_000,
        },
        {
          operationKey: 'operation_unknown', status: 'unknown', reconcileAttempts: 0,
          nextReconcileAt: 1_100, endedAt: 100,
        },
      ])
    } finally {
      sqlite.close()
    }
  })

  it('schedules exactly three due reconciliations at 1, 6, and 36 seconds after a terminal chat event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-usage-schedule-'))
    directories.push(root)
    const reconciliationError = new Error('sk-sensitive-timer-key')
    const reconcileDue = vi.spyOn(ProviderUsageReconciler.prototype, 'reconcileDue')
      .mockRejectedValue(reconciliationError)
    const emitChat = vi.fn()
    const runtime = createApplicationRuntime(options(root, {
      modelProviders: snapshotProviders({ openrouter: {
        listModels: async () => [modelInfo('openai/gpt-4.1-mini', 'OpenRouter')],
        validateCredential: async () => ({ valid: true }),
        stream: async function* () {
          yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
        },
        getGenerationUsage: async (generationId) => ({ generationId }),
      } }),
      emitChat,
    }))
    await authenticate(runtime, 'Alice')
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.update({ activeProvider: 'openrouter' })
    vi.useFakeTimers()
    try {
      await runtime.services.settings.get()
      await vi.advanceTimersByTimeAsync(40_000)
      expect(reconcileDue).not.toHaveBeenCalled()

      const conversation = await runtime.services.chat.createConversation()
      const { requestId } = await runtime.services.chat.send(chatInput(conversation.id, 'schedule reconciliation'))
      await vi.advanceTimersByTimeAsync(0)
      expect(emitChat).toHaveBeenCalledWith(expect.objectContaining({
        type: 'status', requestId, status: 'completed',
      }))

      await vi.advanceTimersByTimeAsync(999)
      expect(reconcileDue).toHaveBeenCalledTimes(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(reconcileDue).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(4_999)
      expect(reconcileDue).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(reconcileDue).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(29_999)
      expect(reconcileDue).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(reconcileDue).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(reconcileDue).toHaveBeenCalledTimes(3)
    } finally {
      await expect(runtime.close()).rejects.toBe(reconciliationError)
      vi.useRealTimers()
    }
  })

  it('closes admission immediately when background reconciliation finds a consistency failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-reconciliation-consistency-'))
    directories.push(root)
    const consistencyError = new ProviderUsageConsistencyError()
    const videoStopError = new Error('later video cleanup failure')
    vi.spyOn(ProviderUsageReconciler.prototype, 'reconcileDue').mockRejectedValue(consistencyError)
    const videoStop = vi.spyOn(VideoJobRunner.prototype, 'stop').mockRejectedValue(videoStopError)
    const databaseClose = vi.spyOn(Database.prototype, 'close')
    const runtime = createApplicationRuntime(options(root, {
      modelProviders: snapshotProviders({ openrouter: {
        listModels: async () => [modelInfo('openai/gpt-4.1-mini', 'OpenRouter')],
        validateCredential: async () => ({ valid: true }),
        stream: async function* () {
          yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
        },
        getGenerationUsage: async (generationId) => ({ generationId }),
      } }),
    }))
    await authenticate(runtime, 'Alice')
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.update({ activeProvider: 'openrouter' })
    vi.useFakeTimers()
    try {
      const conversation = await runtime.services.chat.createConversation()
      await runtime.services.chat.send(chatInput(conversation.id, 'trigger reconciliation'))
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(1_000)

      await expect(runtime.services.chat.send(chatInput(conversation.id, 'must be rejected')))
        .rejects.toMatchObject({ code: 'CONFLICT' })
      await expect(runtime.close()).rejects.toBe(consistencyError)
      expect(videoStop).toHaveBeenCalledTimes(1)
      expect(databaseClose).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts each finite reconciliation delay only after the previous slow round settles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-usage-serial-'))
    directories.push(root)
    const first = deferred<void>()
    const reconcileDue = vi.spyOn(ProviderUsageReconciler.prototype, 'reconcileDue')
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined)
    const runtime = createApplicationRuntime(options(root, {
      modelProviders: snapshotProviders({ openrouter: {
        listModels: async () => [modelInfo('openai/gpt-4.1-mini', 'OpenRouter')],
        validateCredential: async () => ({ valid: true }),
        stream: async function* () {
          yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
        },
        getGenerationUsage: async (generationId) => ({ generationId }),
      } }),
    }))
    await authenticate(runtime, 'Alice')
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.update({ activeProvider: 'openrouter' })
    vi.useFakeTimers()
    try {
      const conversation = await runtime.services.chat.createConversation()
      await runtime.services.chat.send(chatInput(conversation.id, 'serialize reconciliation'))
      await vi.advanceTimersByTimeAsync(1_000)
      expect(reconcileDue).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(9_000)
      expect(reconcileDue).toHaveBeenCalledTimes(1)
      first.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(reconcileDue).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(4_999)
      expect(reconcileDue).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(reconcileDue).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(29_999)
      expect(reconcileDue).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(reconcileDue).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(reconcileDue).toHaveBeenCalledTimes(3)
      await runtime.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears pending usage reconciliation timers and waits for an already-started serialized tail on close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-usage-close-'))
    directories.push(root)
    const first = deferred<void>()
    const reconcileDue = vi.spyOn(ProviderUsageReconciler.prototype, 'reconcileDue')
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined)
    const runtime = createApplicationRuntime(options(root, {
      modelProviders: snapshotProviders({ openrouter: {
        listModels: async () => [modelInfo('openai/gpt-4.1-mini', 'OpenRouter')],
        validateCredential: async () => ({ valid: true }),
        stream: async function* () {
          yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
        },
        getGenerationUsage: async (generationId) => ({ generationId }),
      } }),
    }))
    await authenticate(runtime, 'Alice')
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.update({ activeProvider: 'openrouter' })
    vi.useFakeTimers()
    try {
      const conversation = await runtime.services.chat.createConversation()
      await runtime.services.chat.send(chatInput(conversation.id, 'close reconciliation'))
      await vi.advanceTimersByTimeAsync(1_000)
      expect(reconcileDue).toHaveBeenCalledTimes(1)

      let closed = false
      const closing = runtime.close().then(() => { closed = true })
      await vi.advanceTimersByTimeAsync(100_000)
      expect(closed).toBe(false)
      expect(reconcileDue).toHaveBeenCalledTimes(1)
      first.resolve()
      await closing
      expect(closed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts a never-returning generation lookup and completes close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-reconciliation-abort-'))
    directories.push(root)
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const lookupStarted = deferred<AbortSignal>()
    const provider = snapshotProvider('openrouter', {
      listModels: vi.fn(async () => []),
      validateCredential: vi.fn(async () => ({ valid: true })),
      stream: vi.fn(async function* () { yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' } }),
      getGenerationUsage: vi.fn(async (_generationId: string, signal?: AbortSignal): Promise<never> => {
        lookupStarted.resolve(signal!)
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }),
    })
    const database = openAppDatabase(join(root, 'autoforge.sqlite'))
    database.localAuth.createUserAndSession({
      id: 'user_abort', account: 'Abort', accountNormalized: 'abort',
      passwordDigest: 'digest-abort', createdAt: 1, updatedAt: 1,
    }, 1)
    database.providerUsage.start({
      id: 'usage_abort', operationKey: 'operation_abort', userId: 'user_abort',
      provider: 'openrouter', apiKeyFingerprint: 'fingerprint_test', requestId: 'request_abort',
      model: 'openrouter/model', modality: 'text', startedAt: 0,
    })
    database.providerUsage.bindIdentity('operation_abort', { generationId: 'generation_abort' })
    database.providerUsage.markUnknown('operation_abort', 0)
    database.close()
    const runtime = createApplicationRuntime(options(root, { modelProviders: { openrouter: provider } }))
    try {
      await runtime.recover()
      await vi.advanceTimersByTimeAsync(1_000)
      const signal = await lookupStarted.promise
      const closing = runtime.close()
      await expect(closing).resolves.toBeUndefined()
      expect(signal.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs every shutdown cleanup after video stop fails and throws the earliest cleanup failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-cleanup-all-'))
    directories.push(root)
    const videoError = new Error('video stop failed')
    const executionError = new Error('execution shutdown failed')
    const runFinished = deferred<void>()
    vi.spyOn(AgentOrchestrator.prototype, 'run').mockImplementationOnce(async () => {
      await runFinished.promise
      return { requestId: 'tracked', status: 'cancelled' }
    })
    const agentCancel = vi.spyOn(AgentOrchestrator.prototype, 'cancel').mockImplementation(async () => {
      runFinished.resolve()
    })
    const mediaCancel = vi.spyOn(MediaGenerationOrchestrator.prototype, 'cancel').mockResolvedValue(undefined)
    const videoStop = vi.spyOn(VideoJobRunner.prototype, 'stop').mockRejectedValue(videoError)
    const executionShutdown = vi.spyOn(ExecutionService.prototype, 'shutdown').mockRejectedValue(executionError)
    const databaseClose = vi.spyOn(Database.prototype, 'close')
    const provider = snapshotProvider('openrouter', {
      listModels: vi.fn(async () => [modelInfo('openai/gpt-4.1-mini', 'Text')]),
      validateCredential: vi.fn(async () => ({ valid: true })),
      stream: vi.fn(async function* () { yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' } }),
    })
    const runtime = createApplicationRuntime(options(root, { modelProviders: { openrouter: provider } }))
    await authenticate(runtime)
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.update({ activeProvider: 'openrouter' })
    const conversation = await runtime.services.chat.createConversation()
    await runtime.services.chat.send(chatInput(conversation.id, 'keep active'))
    await vi.waitFor(() => expect(AgentOrchestrator.prototype.run).toHaveBeenCalled())

    await expect(runtime.close()).rejects.toBe(videoError)
    expect(videoStop).toHaveBeenCalledTimes(1)
    expect(agentCancel).toHaveBeenCalledTimes(1)
    expect(mediaCancel).toHaveBeenCalledTimes(1)
    expect(executionShutdown).toHaveBeenCalledTimes(1)
    expect(databaseClose).toHaveBeenCalled()
  })

  it('rethrows a consistency failure that is latched while close cancels active chat work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-close-late-consistency-'))
    directories.push(root)
    const consistencyError = new ProviderUsageConsistencyError()
    const cancelled = deferred<void>()
    vi.spyOn(AgentOrchestrator.prototype, 'run').mockImplementationOnce(async () => {
      await cancelled.promise
      throw consistencyError
    })
    vi.spyOn(AgentOrchestrator.prototype, 'cancel').mockImplementationOnce(async () => {
      cancelled.resolve()
    })
    const provider = snapshotProvider('openrouter', {
      listModels: vi.fn(async () => [modelInfo('openai/gpt-4.1-mini', 'Text')]),
      validateCredential: vi.fn(async () => ({ valid: true })),
      stream: vi.fn(async function* () { yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' } }),
    })
    const runtime = createApplicationRuntime(options(root, { modelProviders: { openrouter: provider } }))
    await authenticate(runtime)
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.update({ activeProvider: 'openrouter' })
    const conversation = await runtime.services.chat.createConversation()
    await runtime.services.chat.send(chatInput(conversation.id, 'late failure'))
    await vi.waitFor(() => expect(AgentOrchestrator.prototype.run).toHaveBeenCalled())

    await expect(runtime.close()).rejects.toBe(consistencyError)
  })

  it('initializes the saved proxy before runtime recovery continues', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-proxy-recovery-'))
    directories.push(root)
    const runtime = createApplicationRuntime(options(root, { networkProxy }))

    await runtime.recover()

    expect(networkProxy.initialize).toHaveBeenCalledWith({ enabled: false, bypassDomains: [] })
    expect(networkProxy.initialize.mock.invocationCallOrder[0])
      .toBeLessThan(recoveryProbe.mock.invocationCallOrder[0]!)
    await runtime.close()
  })

  it('routes OpenRouter and DeepSeek credential validation through the managed fetch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-proxy-provider-'))
    directories.push(root)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('direct fetch is forbidden in this test'))
    networkProxy.fetch.mockImplementation(async () => Response.json({ object: 'list', data: [] }))
    const runtime = createApplicationRuntime(options(root, { networkProxy }))
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.saveProviderApiKey('deepseek', 'sk-deepseek')

    await expect(runtime.services.settings.validateProviderCredential('openrouter'))
      .resolves.toMatchObject({ validation: 'valid' })
    await expect(runtime.services.settings.validateProviderCredential('deepseek'))
      .resolves.toMatchObject({ validation: 'valid' })

    expect(networkProxy.fetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer sk-openrouter',
          'http-referer': 'https://autoforge.bjqisi.cn',
          'x-openrouter-title': 'AutoForge',
        }),
      }),
    )
    expect(networkProxy.fetch).toHaveBeenCalledWith(
      'https://api.deepseek.com/models',
      expect.objectContaining({ headers: { authorization: 'Bearer sk-deepseek' } }),
    )
    await runtime.close()
  })

  it('writes only safe diagnostics for default model providers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-provider-diagnostic-'))
    directories.push(root)
    networkProxy.fetch.mockImplementation(async (input) => {
      const provider = String(input).includes('openrouter.ai') ? 'openrouter' : 'deepseek'
      return Response.json({
        error: {
          code: 400,
          message: `RAW_${provider}_MESSAGE`,
          metadata: { error_type: 'invalid_request', raw: `RAW_${provider}_METADATA` },
        },
      }, { status: 400 })
    })
    const runtime = createApplicationRuntime(options(root, { networkProxy }))
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.saveProviderApiKey('deepseek', 'sk-deepseek')

    await expect(runtime.services.settings.validateProviderCredential('openrouter'))
      .resolves.toMatchObject({ validation: 'unavailable' })
    await expect(runtime.services.settings.validateProviderCredential('deepseek'))
      .resolves.toMatchObject({ validation: 'unavailable' })

    const path = join(root, 'logs', 'model-provider.jsonl')
    await vi.waitFor(async () => {
      const records = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({ provider: 'openrouter', operation: 'models', status: 400 }),
        expect.objectContaining({ provider: 'deepseek', operation: 'models', status: 400 }),
      ]))
      expect(JSON.stringify(records)).not.toContain('RAW_')
    })
    await runtime.close()
  })

  it('applies proxy changes before committing settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-proxy-commit-'))
    directories.push(root)
    const runtime = createApplicationRuntime(options(root, { networkProxy }))

    const next = await runtime.services.settings.update({
      proxy: { enabled: true, httpProxy: 'http://127.0.0.1:7890', bypassDomains: [] },
    })

    expect(networkProxy.transition).toHaveBeenCalledWith(next.proxy)
    await expect(runtime.services.settings.get()).resolves.toMatchObject({ proxy: next.proxy })
    await runtime.close()
  })

  it('retains the old setting when proxy application fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-proxy-rollback-'))
    directories.push(root)
    networkProxy.transition.mockRejectedValueOnce(toSafeAppError({ code: 'NETWORK_PROXY_APPLY_FAILED' }))
    const runtime = createApplicationRuntime(options(root, { networkProxy }))

    await expect(runtime.services.settings.update({
      proxy: { enabled: true, socketProxy: 'socks5://127.0.0.1:7891', bypassDomains: [] },
    })).rejects.toMatchObject({ code: 'NETWORK_PROXY_APPLY_FAILED' })
    await expect(runtime.services.settings.get()).resolves.toMatchObject({
      proxy: { enabled: false, bypassDomains: [] },
    })
    await runtime.close()
  })

  it('restores the previous runtime proxy when settings persistence fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-proxy-persistence-rollback-'))
    directories.push(root)
    const runtime = createApplicationRuntime(options(root, { networkProxy }))
    const previous = {
      enabled: true,
      httpProxy: 'http://127.0.0.1:7891',
      bypassDomains: ['previous.example'],
    }
    await runtime.services.settings.update({ proxy: previous })
    await expect(runtime.services.settings.get()).resolves.toMatchObject({ proxy: previous })
    networkProxy.transition.mockClear()
    vi.spyOn(SettingsService.prototype, 'commit').mockImplementationOnce(() => {
      throw new Error('settings write failed')
    })
    const candidate = {
      enabled: true,
      httpProxy: 'http://127.0.0.1:7890',
      bypassDomains: [],
    }

    await expect(runtime.services.settings.update({ proxy: candidate }))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(networkProxy.transition.mock.calls).toEqual([
      [candidate],
      [previous],
    ])
    await expect(runtime.services.settings.get()).resolves.toMatchObject({ proxy: previous })
    await runtime.close()
  })

  it('fails managed networking closed when durable proxy rollback cannot replace the rejected candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-proxy-terminal-rollback-'))
    directories.push(root)
    const candidateRestored = deferred<void>()
    const session = {
      setProxy: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('durable direct rollback failed'))
        .mockImplementationOnce(() => candidateRestored.promise),
      closeAllConnections: vi.fn().mockResolvedValue(undefined),
      fetch: vi.fn(async () => new Response(null, { status: 204 })),
    }
    const managedProxy = new NetworkProxyService(session)
    const runtime = createApplicationRuntime(options(root, { networkProxy: managedProxy }))
    vi.spyOn(SettingsService.prototype, 'commit').mockImplementationOnce(() => {
      throw new Error('settings write failed')
    })
    const candidate = {
      enabled: true,
      httpProxy: 'http://127.0.0.1:7890',
      bypassDomains: ['candidate.example'],
    }

    const update = runtime.services.settings.update({ proxy: candidate })
    await vi.waitFor(() => expect(session.setProxy).toHaveBeenCalledTimes(3))
    const queuedSnapshot = managedProxy.snapshot()
    const queuedFetch = managedProxy.fetch('https://queued.example')
    candidateRestored.resolve()

    const safeError = {
      code: 'NETWORK_PROXY_APPLY_FAILED',
      message: 'The network proxy configuration could not be applied.',
    }
    await expect(update).rejects.toEqual(safeError)
    await expect(queuedSnapshot).rejects.toEqual(safeError)
    await expect(queuedFetch).rejects.toEqual(safeError)
    await expect(runtime.services.settings.get()).resolves.toMatchObject({
      proxy: { enabled: false, bypassDomains: [] },
    })
    await expect(managedProxy.snapshot()).rejects.toEqual(safeError)
    await expect(managedProxy.fetch('https://future.example')).rejects.toEqual(safeError)
    await expect(managedProxy.transition(candidate)).rejects.toEqual(safeError)
    const operation = vi.fn(async () => undefined)
    await expect(managedProxy.withTransportLease(operation)).rejects.toEqual(safeError)
    expect(operation).not.toHaveBeenCalled()
    expect(session.fetch).not.toHaveBeenCalled()
    await runtime.close()
  })

  it('keeps the successful second proxy generation live after a concurrent first commit fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-proxy-concurrent-first-fails-'))
    directories.push(root)
    const proxy = serializedProxyHarness()
    const runtime = createApplicationRuntime(options(root, { networkProxy: proxy.networkProxy }))
    const realCommit = SettingsService.prototype.commit
    vi.spyOn(SettingsService.prototype, 'commit').mockImplementation(function (this: SettingsService, settings) {
      if (settings.proxy.httpProxy === 'http://127.0.0.1:7890') throw new Error('first commit failed')
      return realCommit.call(this, settings)
    })
    const firstProxy = {
      enabled: true,
      httpProxy: 'http://127.0.0.1:7890',
      bypassDomains: ['first.example'],
    }
    const secondProxy = {
      enabled: true,
      httpProxy: 'http://127.0.0.1:7891',
      bypassDomains: ['second.example'],
    }

    const first = runtime.services.settings.update({ proxy: firstProxy })
    await proxy.firstStarted
    const second = runtime.services.settings.update({ proxy: secondProxy })
    proxy.releaseFirst()

    await expect(first).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    await expect(second).resolves.toMatchObject({ proxy: secondProxy })
    await expect(runtime.services.settings.get()).resolves.toMatchObject({ proxy: secondProxy })
    expect(proxy.liveProxy()).toEqual(secondProxy)
    await runtime.close()
  })

  it('rolls a failed second proxy commit back to the successful first concurrent generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-proxy-concurrent-second-fails-'))
    directories.push(root)
    const proxy = serializedProxyHarness()
    const runtime = createApplicationRuntime(options(root, { networkProxy: proxy.networkProxy }))
    const realCommit = SettingsService.prototype.commit
    vi.spyOn(SettingsService.prototype, 'commit').mockImplementation(function (this: SettingsService, settings) {
      if (settings.proxy.httpProxy === 'http://127.0.0.1:7891') throw new Error('second commit failed')
      return realCommit.call(this, settings)
    })
    const firstProxy = {
      enabled: true,
      httpProxy: 'http://127.0.0.1:7890',
      bypassDomains: ['first.example'],
    }
    const secondProxy = {
      enabled: true,
      httpProxy: 'http://127.0.0.1:7891',
      bypassDomains: ['second.example'],
    }

    const first = runtime.services.settings.update({ proxy: firstProxy })
    await proxy.firstStarted
    const second = runtime.services.settings.update({ proxy: secondProxy })
    proxy.releaseFirst()

    await expect(first).resolves.toMatchObject({ proxy: firstProxy })
    await expect(second).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    await expect(runtime.services.settings.get()).resolves.toMatchObject({ proxy: firstProxy })
    expect(proxy.liveProxy()).toEqual(firstProxy)
    await runtime.close()
  })

  it('serializes a settings-only patch behind an in-flight proxy transaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-settings-concurrent-'))
    directories.push(root)
    const proxy = serializedProxyHarness()
    const runtime = createApplicationRuntime(options(root, { networkProxy: proxy.networkProxy }))
    const firstProxy = {
      enabled: true,
      httpProxy: 'http://127.0.0.1:7890',
      bypassDomains: [],
    }

    const proxyUpdate = runtime.services.settings.update({ proxy: firstProxy })
    await proxy.firstStarted
    const settingsOnlyUpdate = runtime.services.settings.update({ theme: 'dark' })
    proxy.releaseFirst()

    await expect(proxyUpdate).resolves.toMatchObject({ proxy: firstProxy })
    await expect(settingsOnlyUpdate).resolves.toMatchObject({ theme: 'dark', proxy: firstProxy })
    await expect(runtime.services.settings.get()).resolves.toMatchObject({ theme: 'dark', proxy: firstProxy })
    expect(proxy.liveProxy()).toEqual(firstProxy)
    await runtime.close()
  })

  it('applies the persisted theme at startup and every committed theme update', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-theme-'))
    directories.push(root)
    const applyTheme = vi.fn()
    const runtimeOptions = { ...options(root), applyTheme }
    const runtime = createApplicationRuntime(runtimeOptions)

    expect(applyTheme).toHaveBeenCalledWith('system')
    await runtime.services.settings.update({ theme: 'dark' })
    expect(applyTheme).toHaveBeenLastCalledWith('dark')
    expect(applyTheme).toHaveBeenCalledTimes(2)
    await runtime.close()

    applyTheme.mockClear()
    const restarted = createApplicationRuntime({ ...options(root), applyTheme })
    expect(applyTheme).toHaveBeenCalledOnce()
    expect(applyTheme).toHaveBeenCalledWith('dark')
    await restarted.close()
  })

  it('keeps media paths in main while using explicit media ports and exact conversation preferences', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-media-'))
    directories.push(root)
    const source = join(root, 'private-source.png')
    const copied = join(root, 'copied.png')
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('payload')])
    await writeFile(source, png)
    const chooseMediaFiles = vi.fn<(remainingSlots: number) => Promise<string[]>>(async () => [])
    const chooseMediaSavePath = vi.fn(async () => copied)
    const revealPath = vi.fn()
    const runtime = createApplicationRuntime({
      authService: createTestAuthService(),
      paths: {
        database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
        projects: join(root, 'projects'), installations: join(root, 'workflows'),
        workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(value),
        decrypt: async (value) => ({ value: value.toString(), shouldReEncrypt: false }),
      },
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles,
      readClipboardImage: () => ({ bytes: png, mimeType: 'image/png', name: 'clipboard.png' }),
      chooseMediaSavePath,
      revealPath,
      openExternal: async () => undefined,
      emitChat: vi.fn(), emitExecution: vi.fn(),
      networkProxy,
      browserWorkspace: createBrowserWorkspace(),
    })
    await authenticate(runtime)
    const conversation = await runtime.services.chat.createConversation()
    expect(await runtime.services.chat.getGenerationPreferences(conversation.id)).toMatchObject({
      outputType: 'auto', models: {},
    })
    const preferences = {
      outputType: 'image' as const, models: { image: 'image-model' },
      generation: {
        image: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
        audio: { format: 'mp3' },
        video: { durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false },
      },
    } as const
    await expect(runtime.services.chat.updateGenerationPreferences(conversation.id, preferences)).resolves.toEqual(preferences)
    await expect(runtime.services.media.pickFiles({ conversationId: conversation.id, existingAssetIds: [] })).resolves.toEqual([])
    chooseMediaFiles.mockResolvedValueOnce([source])
    const [picked] = await runtime.services.media.pickFiles({ conversationId: conversation.id, existingAssetIds: [] })
    const [clipboard] = await runtime.services.media.importClipboardImage({ conversationId: conversation.id, existingAssetIds: [picked!.id] })
    expect(JSON.stringify([picked, clipboard])).not.toContain(root)
    await runtime.services.media.saveCopy(picked!.id)
    await runtime.services.media.reveal(picked!.id)
    expect(chooseMediaSavePath).toHaveBeenCalledWith(picked!.name)
    expect(revealPath).toHaveBeenCalledWith(expect.stringContaining(`${conversation.id}/`))
    await expect(runtime.services.media.saveCopy('missing_asset')).rejects.toMatchObject({ code: 'MEDIA_ASSET_UNAVAILABLE' })
    await runtime.close()
  })

  it('stores provider credentials separately and routes new chats to the active provider default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-'))
    directories.push(root)
    const openrouter = {
      listModels: vi.fn(async () => [
        modelInfo('openrouter/model', 'OpenRouter model'),
        modelInfo('openrouter/text-default', 'OpenRouter text default'),
      ]),
      validateCredential: vi.fn(async () => ({ valid: true })),
      stream: vi.fn(async function* () {
        yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
      }),
    }
    const deepseek = {
      listModels: vi.fn(async () => [modelInfo('deepseek-v4-flash', 'deepseek-v4-flash')]),
      validateCredential: vi.fn(async () => ({ valid: true })),
      stream: vi.fn(async function* () {
        yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
      }),
    }
    const runtime = createApplicationRuntime({
      authService: createTestAuthService(),
      paths: {
        database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
        projects: join(root, 'projects'), installations: join(root, 'workflows'),
        workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(value),
        decrypt: async (value) => ({ value: value.toString(), shouldReEncrypt: false }),
      },
      modelProviders: snapshotProviders({ openrouter, deepseek }),
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(),
      emitExecution: vi.fn(),
      networkProxy,
      browserWorkspace: createBrowserWorkspace(),
    })

    await authenticate(runtime)

    await expect(runtime.services.settings.get()).resolves.toMatchObject({
      activeProvider: 'deepseek',
      defaultModels: {
        deepseek: { text: 'deepseek-v4-flash' },
        openrouter: { text: 'openai/gpt-4.1-mini' },
      },
    })
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.saveProviderApiKey('deepseek', 'sk-deepseek')
    await runtime.services.settings.update({ activeProvider: 'deepseek' })
    await expect(runtime.services.settings.listProviderModels('deepseek')).resolves.toEqual([
      modelInfo('deepseek-v4-flash', 'deepseek-v4-flash'),
    ])
    await expect(runtime.services.settings.listProviderModels('deepseek')).resolves.toEqual([
      modelInfo('deepseek-v4-flash', 'deepseek-v4-flash'),
    ])
    expect(deepseek.listModels).toHaveBeenCalledTimes(1)
    deepseek.listModels.mockResolvedValueOnce([
      modelInfo('deepseek-v4-flash', 'DeepSeek refreshed'),
    ])
    await expect(runtime.services.settings.listProviderModels('deepseek', true)).resolves.toEqual([
      modelInfo('deepseek-v4-flash', 'DeepSeek refreshed'),
    ])
    expect(deepseek.listModels).toHaveBeenCalledTimes(2)

    const conversation = await runtime.services.chat.createConversation()
    await runtime.services.chat.send(chatInput(conversation.id, 'hello'))
    await vi.waitFor(() => expect(deepseek.stream).toHaveBeenCalled())
    expect(openrouter.stream).not.toHaveBeenCalled()
    expect(deepseek.stream).toHaveBeenCalledWith(expect.objectContaining({
      model: 'deepseek-v4-flash',
    }))

    const currentSettings = await runtime.services.settings.get()
    await runtime.services.settings.update({
      activeProvider: 'openrouter',
      defaultModels: {
        ...currentSettings.defaultModels,
        openrouter: { text: 'openrouter/text-default' },
      },
    })
    const openRouterConversation = await runtime.services.chat.createConversation()
    await runtime.services.chat.send(chatInput(openRouterConversation.id, 'hello from OpenRouter'))
    await vi.waitFor(() => expect(openrouter.stream).toHaveBeenCalled())
    expect(openrouter.stream).toHaveBeenCalledWith(expect.objectContaining({
      model: 'openrouter/text-default',
    }))

    await runtime.services.settings.clearProviderApiKey('deepseek')
    await expect(runtime.services.settings.validateProviderCredential('deepseek'))
      .resolves.toMatchObject({ provider: 'deepseek', configured: false, validation: 'unchecked' })
    await expect(runtime.services.settings.validateProviderCredential('openrouter'))
      .resolves.toMatchObject({ provider: 'openrouter', configured: true, validation: 'valid' })
    openrouter.validateCredential.mockRejectedValueOnce({
      code: 'MODEL_PROVIDER_ACCESS_DENIED',
      message: 'The model provider denied access.',
    })
    await expect(runtime.services.settings.validateProviderCredential('openrouter'))
      .resolves.toMatchObject({ provider: 'openrouter', configured: true, validation: 'denied' })
    await runtime.close()
  })

  it('sends only same-conversation history to the second text turn without changing chat send output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-context-history-'))
    directories.push(root)
    const captured: ModelStreamRequest[] = []
    const stream = vi.fn(async function* (request: ModelStreamRequest) {
      captured.push(request)
      if (captured.length === 1) {
        yield { type: 'text_delta' as const, choiceIndex: 0, text: '第一轮回答' }
      }
      yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
    })
    const runtime = createApplicationRuntime({
      authService: createTestAuthService(),
      paths: {
        database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
        projects: join(root, 'projects'), installations: join(root, 'workflows'),
        workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(value),
        decrypt: async (value) => ({ value: value.toString(), shouldReEncrypt: false }),
      },
      modelProviders: snapshotProviders({
        openrouter: {
          listModels: vi.fn(async () => [{ ...modelInfo('openrouter/context', 'Context model'), contextLength: 128_000 }]),
          validateCredential: vi.fn(async () => ({ valid: true })),
          stream,
        },
      }),
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(),
      emitExecution: vi.fn(),
      networkProxy,
      browserWorkspace: createBrowserWorkspace(),
    })
    await authenticate(runtime)
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    const settings = await runtime.services.settings.get()
    await runtime.services.settings.update({
      activeProvider: 'openrouter',
      defaultModels: { ...settings.defaultModels, openrouter: { text: 'openrouter/context' } },
    })

    const conversation = await runtime.services.chat.createConversation()
    await expect(runtime.services.chat.send(chatInput(conversation.id, '第一轮问题')))
      .resolves.toEqual({ requestId: expect.any(String) })
    await vi.waitFor(() => expect(captured).toHaveLength(1))
    await vi.waitFor(async () => expect(await runtime.services.chat.listMessages(conversation.id))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', blocks: [{ type: 'text', text: '第一轮回答' }] }),
      ])))

    await runtime.services.chat.send(chatInput(conversation.id, '第二轮追问'))
    await vi.waitFor(() => expect(captured).toHaveLength(2))
    expect(captured[1]?.messages).toEqual([
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: '第一轮回答' },
      { role: 'user', content: '第二轮追问' },
    ])

    const isolated = await runtime.services.chat.createConversation()
    await runtime.services.chat.send(chatInput(isolated.id, '独立问题'))
    await vi.waitFor(() => expect(captured).toHaveLength(3))
    expect(captured[2]?.messages).toEqual([{ role: 'user', content: '独立问题' }])
    await runtime.close()
  })

  it('bills real context-summary streams through the Application-supplied provider snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-summary-billing-'))
    directories.push(root)
    const databasePath = join(root, 'autoforge.sqlite')
    const database = openAppDatabase(databasePath)
    database.conversations.insert({ id: 'conversation_summary_billing', title: 'Summary billing' })
    for (let turn = 0; turn < 10; turn += 1) {
      database.messages.insert({
        id: `summary_user_${turn}`, conversationId: 'conversation_summary_billing', role: 'user',
        blocks: [{ type: 'text', text: `问题 ${turn} ${'长内容'.repeat(80)}` }], createdAt: turn * 2 + 1,
      })
      database.messages.insert({
        id: `summary_assistant_${turn}`, conversationId: 'conversation_summary_billing', role: 'assistant',
        blocks: [{ type: 'text', text: `回答 ${turn} ${'历史'.repeat(80)}` }], createdAt: turn * 2 + 2,
      })
    }
    database.close()
    let summaryCalls = 0
    const stream = vi.fn(async function* (request: ModelStreamRequest) {
      const summary = request.maxOutputTokens !== undefined
      if (summary) summaryCalls += 1
      yield { type: 'generation' as const, id: summary ? `generation_summary_${summaryCalls}` : 'generation_answer' }
      yield { type: 'text_delta' as const, choiceIndex: 0, text: summary ? '压缩后的历史摘要' : '最终回答' }
      yield {
        type: 'usage' as const,
        inputTokens: summary ? 20 : 4,
        outputTokens: summary ? 5 : 2,
        totalTokens: summary ? 25 : 6,
        costUsd: summary ? '0.04' : '0.01',
      }
      yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
    })
    const emitChat = vi.fn()
    const provider = snapshotProvider('openrouter', {
      listModels: vi.fn(async () => [{ ...modelInfo('openrouter/context', 'Context'), contextLength: 1_000 }]),
      validateCredential: vi.fn(async () => ({ valid: true })),
      stream,
    })
    const runtime = createApplicationRuntime(options(root, {
      modelProviders: { openrouter: provider },
      emitChat,
    }))
    const session = await authenticate(runtime)
    await runtime.services.chat.listConversations()
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.update({
      activeProvider: 'openrouter',
      defaultModels: {
        deepseek: { text: 'deepseek-v4-flash' },
        openrouter: { text: 'openrouter/context' },
      },
    })

    const sent = await runtime.services.chat.send(chatInput('conversation_summary_billing', '继续'))
    await vi.waitFor(() => expect(emitChat).toHaveBeenCalledWith(expect.objectContaining({
      type: 'status', requestId: sent.requestId, status: 'completed',
    })))
    await runtime.close()

    const sqlite = new Database(databasePath, { readonly: true })
    try {
      const events = sqlite.prepare(`
        SELECT operation_key AS operationKey, user_id AS userId, api_key_fingerprint AS apiKeyFingerprint,
               status, cost_usd AS costUsd
        FROM provider_usage_events ORDER BY operation_key
      `).all() as Array<Record<string, unknown>>
      expect(events).toContainEqual(expect.objectContaining({
        operationKey: expect.stringMatching(`^conversation-summary:${sent.requestId}:`),
        userId: session.user.id,
        apiKeyFingerprint: 'fingerprint_test',
        status: 'reported',
        costUsd: '0.04',
      }))
      expect(events).toContainEqual(expect.objectContaining({
        operationKey: `agent:${sent.requestId}:turn:0`,
        userId: session.user.id,
        apiKeyFingerprint: 'fingerprint_test',
        status: 'reported',
        costUsd: '0.01',
      }))
    } finally {
      sqlite.close()
    }
  })

  it('emits a terminal conflict for a concurrent same-conversation send without persisting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-context-conflict-'))
    directories.push(root)
    let markFirstStarted!: () => void
    let releaseFirst!: () => void
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve })
    let providerCalls = 0
    const stream = vi.fn(async function* () {
      providerCalls += 1
      if (providerCalls === 1) {
        markFirstStarted()
        await firstReleased
      }
      yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
    })
    const chatEvents: ChatEvent[] = []
    const runtime = createApplicationRuntime({
      authService: createTestAuthService(),
      paths: {
        database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
        projects: join(root, 'projects'), installations: join(root, 'workflows'),
        workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(value),
        decrypt: async (value) => ({ value: value.toString(), shouldReEncrypt: false }),
      },
      modelProviders: snapshotProviders({
        openrouter: {
          listModels: vi.fn(async () => [modelInfo('openrouter/context', 'Context model')]),
          validateCredential: vi.fn(async () => ({ valid: true })),
          stream,
        },
      }),
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: (event) => { chatEvents.push(event) },
      emitExecution: vi.fn(),
      networkProxy,
      browserWorkspace: createBrowserWorkspace(),
    })
    await authenticate(runtime, 'Alice')
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    const settings = await runtime.services.settings.get()
    await runtime.services.settings.update({
      activeProvider: 'openrouter',
      defaultModels: { ...settings.defaultModels, openrouter: { text: 'openrouter/context' } },
    })
    const conversation = await runtime.services.chat.createConversation()

    const first = await runtime.services.chat.send(chatInput(conversation.id, 'first'))
    await firstStarted
    const duplicate = await runtime.services.chat.send(chatInput(conversation.id, 'duplicate'))

    await vi.waitFor(() => expect(chatEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'status',
        conversationId: conversation.id,
        requestId: duplicate.requestId,
        status: 'failed',
        error: expect.objectContaining({ code: 'CONFLICT' }),
      }),
    ])))
    expect(await runtime.services.chat.listMessages(conversation.id)).toEqual([
      expect.objectContaining({ role: 'user', blocks: [{ type: 'text', text: 'first' }] }),
      expect.objectContaining({ role: 'assistant', blocks: [] }),
    ])

    releaseFirst()
    await vi.waitFor(() => expect(chatEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'status', requestId: first.requestId, status: 'completed' }),
    ])))
    const retry = await runtime.services.chat.send(chatInput(conversation.id, 'retry'))
    await vi.waitFor(() => expect(chatEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'status', requestId: retry.requestId, status: 'completed' }),
    ])))
    expect(stream).toHaveBeenCalledTimes(2)
    expect(await runtime.services.chat.listMessages(conversation.id)).toHaveLength(4)
    await runtime.close()
  })

  it('replaces historical media bytes and paths with a safe marker on a text follow-up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-context-media-'))
    directories.push(root)
    const source = join(root, 'image.png')
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('private-image-payload')])
    await writeFile(source, png)
    const captured: ModelStreamRequest[] = []
    const stream = vi.fn(async function* (request: ModelStreamRequest) {
      captured.push(request)
      if (captured.length === 1) yield { type: 'text_delta' as const, choiceIndex: 0, text: '我看到了图片' }
      yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
    })
    const runtime = createApplicationRuntime({
      authService: createTestAuthService(),
      paths: {
        database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
        projects: join(root, 'projects'), installations: join(root, 'workflows'),
        workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(value),
        decrypt: async (value) => ({ value: value.toString(), shouldReEncrypt: false }),
      },
      modelProviders: snapshotProviders({
        openrouter: {
          listModels: vi.fn(async () => [{ ...visionTextModelInfo('openrouter/vision-context'), contextLength: 128_000 }]),
          validateCredential: vi.fn(async () => ({ valid: true })),
          stream,
        },
      }),
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [source],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(),
      emitExecution: vi.fn(),
      networkProxy,
      browserWorkspace: createBrowserWorkspace(),
    })
    await authenticate(runtime)
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    const settings = await runtime.services.settings.get()
    await runtime.services.settings.update({
      activeProvider: 'openrouter',
      defaultModels: { ...settings.defaultModels, openrouter: { text: 'openrouter/vision-context' } },
    })
    const conversation = await runtime.services.chat.createConversation()
    const [asset] = await runtime.services.media.pickFiles({ conversationId: conversation.id, existingAssetIds: [] })
    await runtime.services.chat.send({
      ...chatInput(conversation.id, '第一轮图片问题'), assetIds: [asset!.id], outputType: 'text',
    })
    await vi.waitFor(() => expect(captured).toHaveLength(1))
    expect(JSON.stringify(captured[0]?.messages)).toContain(png.toString('base64'))
    await vi.waitFor(async () => expect(await runtime.services.chat.listMessages(conversation.id))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', blocks: [{ type: 'text', text: '我看到了图片' }] }),
      ])))

    await runtime.services.chat.send(chatInput(conversation.id, '第二轮只问文字'))
    await vi.waitFor(() => expect(captured).toHaveLength(2))
    const followUp = JSON.stringify(captured[1]?.messages)
    expect(followUp).toContain('名称: image.png')
    expect(followUp).not.toContain(png.toString('base64'))
    expect(followUp).not.toContain(source)
    await runtime.close()
  })

  it('routes an explicit image request to OpenRouter image generation without invoking text chat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-image-route-'))
    directories.push(root)
    const generated = Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      Buffer.from('generated'),
    ])
    const directFetch = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('direct fetch is forbidden in this test'))
    const mediaRequest = vi.fn(async () => ({
      statusCode: 200,
      statusMessage: 'OK',
      rawHeaders: [
        'content-type', 'image/png',
        'content-length', String(generated.byteLength),
      ],
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from(generated))
          controller.close()
        },
      }),
      closed: Promise.resolve(),
      cancel: vi.fn(async () => undefined),
    }))
    const generateImage = vi.fn(async () => ({
      outputs: [{
        type: 'url' as const,
        url: 'https://93.184.216.34/generated.png',
      }],
    }))
    const stream = vi.fn(async function* () {
      yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
    })
    const runtime = createApplicationRuntime({
      authService: createTestAuthService(),
      paths: {
        database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
        projects: join(root, 'projects'), installations: join(root, 'workflows'),
        workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(value),
        decrypt: async (value) => ({ value: value.toString(), shouldReEncrypt: false }),
      },
      modelProviders: snapshotProviders({
        openrouter: {
          listModels: vi.fn(async () => [imageModelInfo('openrouter/image')]),
          validateCredential: vi.fn(async () => ({ valid: true })),
          stream,
          generateImage,
        },
      }),
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(),
      emitExecution: vi.fn(),
      networkProxy,
      mediaTransport: { request: mediaRequest },
      browserWorkspace: createBrowserWorkspace(),
    })
    await authenticate(runtime)
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.update({
      activeProvider: 'openrouter',
      defaultModels: {
        deepseek: { text: 'deepseek-v4-flash' },
        openrouter: { text: 'openrouter/text', image: 'openrouter/image' },
      },
    })
    const conversation = await runtime.services.chat.createConversation()

    await runtime.services.chat.send({
      ...chatInput(conversation.id, 'make an image'),
      outputType: 'image',
    })

    await vi.waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(mediaRequest).toHaveBeenCalledWith(expect.objectContaining({
      url: new URL('https://93.184.216.34/generated.png'),
      destinationAddress: '93.184.216.34',
      route: { kind: 'direct' },
      signal: expect.any(AbortSignal),
    })))
    await vi.waitFor(async () => expect(await runtime.services.chat.listMessages(conversation.id))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          blocks: [expect.objectContaining({
            type: 'media',
            kind: 'image',
            purpose: 'output',
          })],
        }),
      ])))
    expect(networkProxy.withTransportLease).toHaveBeenCalledOnce()
    expect(stream).not.toHaveBeenCalled()
    expect(directFetch).not.toHaveBeenCalled()
    await runtime.close()
  })

  it('routes audio, video, automatic output, and conversation model preferences without fallbacks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-media-routes-'))
    directories.push(root)
    const source = join(root, 'reference.png')
    const png = Buffer.from('89504e470d0a1a0a', 'hex')
    await writeFile(source, png)
    const mp3 = Buffer.from('49443304000000000000', 'hex')
    const generateImage = vi.fn(async () => ({
      outputs: [{
        type: 'base64' as const,
        mimeType: 'image/png',
        dataBase64: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'),
      }],
    }))
    const submitVideo = vi.fn(async () => ({
      providerJobId: 'provider_video_1',
      status: 'pending' as const,
    }))
    const stream = vi.fn(async function* (request: { output?: { type: string } }) {
      if (request.output?.type === 'audio') {
        yield {
          type: 'audio_delta' as const,
          choiceIndex: 0,
          dataBase64: mp3.toString('base64'),
        }
      }
      yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
    })
    const runtime = createApplicationRuntime({
      authService: createTestAuthService(),
      paths: {
        database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
        projects: join(root, 'projects'), installations: join(root, 'workflows'),
        workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(value),
        decrypt: async (value) => ({ value: value.toString(), shouldReEncrypt: false }),
      },
      modelProviders: snapshotProviders({
        openrouter: {
          listModels: vi.fn(async () => [
            visionTextModelInfo('openrouter/text'),
            imageModelInfo('openrouter/image'),
            imageModelInfo('openrouter/image-preferred'),
            audioModelInfo('openrouter/audio'),
            videoModelInfo('openrouter/video'),
          ]),
          validateCredential: vi.fn(async () => ({ valid: true })),
          stream,
          generateImage,
          submitVideo,
        },
      }),
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [source],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(),
      emitExecution: vi.fn(),
      networkProxy,
      browserWorkspace: createBrowserWorkspace(),
    })
    await authenticate(runtime)
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.update({
      activeProvider: 'openrouter',
      defaultModels: {
        deepseek: { text: 'deepseek-v4-flash' },
        openrouter: {
          text: 'openrouter/text',
          image: 'openrouter/image',
          audio: 'openrouter/audio',
          video: 'openrouter/video',
        },
      },
    })

    const textConversation = await runtime.services.chat.createConversation()
    const [textAsset] = await runtime.services.media.pickFiles({
      conversationId: textConversation.id,
      existingAssetIds: [],
    })
    await runtime.services.chat.send({
      ...chatInput(textConversation.id, 'describe this image'),
      assetIds: [textAsset!.id],
      outputType: 'text',
    })
    await vi.waitFor(() => expect(stream).toHaveBeenCalledWith(expect.objectContaining({
      model: 'openrouter/text',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'describe this image' },
          {
            type: 'media',
            kind: 'image',
            mimeType: 'image/png',
            dataBase64: png.toString('base64'),
          },
        ],
      }],
    })))
    expect(JSON.stringify(await runtime.services.chat.listMessages(textConversation.id)))
      .not.toContain(png.toString('base64'))

    const audioConversation = await runtime.services.chat.createConversation()
    await runtime.services.chat.send({
      ...chatInput(audioConversation.id, 'speak'),
      outputType: 'audio',
    })
    await vi.waitFor(() => expect(stream).toHaveBeenCalledWith(expect.objectContaining({
      model: 'openrouter/audio',
      output: expect.objectContaining({ type: 'audio', format: 'mp3' }),
    })))

    const videoConversation = await runtime.services.chat.createConversation()
    await runtime.services.chat.send({
      ...chatInput(videoConversation.id, 'make a video'),
      outputType: 'video',
    })
    expect(submitVideo).toHaveBeenCalledWith(expect.objectContaining({
      model: 'openrouter/video',
      options: expect.objectContaining({ durationSeconds: 5, resolution: '720p' }),
    }))

    submitVideo.mockRejectedValueOnce({ code: 'MODEL_PROVIDER_REQUEST_FAILED' })
    const failedVideoConversation = await runtime.services.chat.createConversation()
    await expect(runtime.services.chat.send({
      ...chatInput(failedVideoConversation.id, 'fail this video'),
      outputType: 'video',
    })).resolves.toEqual({ requestId: expect.any(String) })
    expect(await runtime.services.chat.listMessages(failedVideoConversation.id))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({
          role: 'assistant',
          blocks: [expect.objectContaining({
            type: 'media_generation',
            kind: 'video',
            status: 'failed',
            errorCode: 'MODEL_PROVIDER_REQUEST_FAILED',
          })],
        }),
      ]))

    const automaticConversation = await runtime.services.chat.createConversation()
    await runtime.services.chat.send({
      ...chatInput(automaticConversation.id, 'make an automatic image'),
      model: 'openrouter/image',
    })
    await vi.waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1))

    const preferredConversation = await runtime.services.chat.createConversation()
    await runtime.services.chat.updateGenerationPreferences(preferredConversation.id, {
      outputType: 'image',
      models: { image: 'openrouter/image-preferred' },
      generation: chatInput(preferredConversation.id, '').generation,
    })
    await runtime.services.chat.send({
      ...chatInput(preferredConversation.id, 'use my preference'),
      outputType: 'image',
    })
    await vi.waitFor(() => expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({
      model: 'openrouter/image-preferred',
    })))

    const settingsWithoutImageDefault = await runtime.services.settings.get()
    await runtime.services.settings.update({
      defaultModels: {
        ...settingsWithoutImageDefault.defaultModels,
        openrouter: {
          text: 'openrouter/text',
          audio: 'openrouter/audio',
          video: 'openrouter/video',
        },
      },
    })
    const missingDefaultConversation = await runtime.services.chat.createConversation()
    await expect(runtime.services.chat.send({
      ...chatInput(missingDefaultConversation.id, 'choose an image model'),
      outputType: 'image',
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(generateImage).toHaveBeenCalledTimes(2)
    await runtime.close()
  })

  it('rejects missing, invalid, and unsupported provider requests before inference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-route-rejections-'))
    directories.push(root)
    const source = join(root, 'input.png')
    await writeFile(source, Buffer.from('89504e470d0a1a0a', 'hex'))
    const stream = vi.fn(async function* () {
      yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
    })
    const validateCredential = vi.fn(async () => ({ valid: false }))
    const listModels = vi.fn(async () => [modelInfo('deepseek-v4-flash', 'DeepSeek')])
    const runtime = createApplicationRuntime({
      authService: createTestAuthService(),
      paths: {
        database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
        projects: join(root, 'projects'), installations: join(root, 'workflows'),
        workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(value),
        decrypt: async (value) => ({ value: value.toString(), shouldReEncrypt: false }),
      },
      modelProviders: snapshotProviders({
        deepseek: {
          listModels,
          validateCredential,
          stream,
        },
      }),
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [source],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(),
      emitExecution: vi.fn(),
      networkProxy,
      browserWorkspace: createBrowserWorkspace(),
    })
    await authenticate(runtime)
    await runtime.services.settings.update({ activeProvider: 'openrouter' })
    const conversation = await runtime.services.chat.createConversation()
    await expect(runtime.services.chat.send(chatInput(conversation.id, 'missing key')))
      .rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' })
    expect(validateCredential).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()

    await runtime.services.settings.update({ activeProvider: 'deepseek' })
    await runtime.services.settings.saveProviderApiKey('deepseek', 'invalid')
    await expect(runtime.services.chat.send(chatInput(conversation.id, 'invalid key')))
      .rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' })
    expect(stream).not.toHaveBeenCalled()

    await expect(runtime.services.chat.send({
      ...chatInput(conversation.id, 'make an image'),
      outputType: 'image',
    })).rejects.toMatchObject({ code: 'MODEL_MODALITY_UNSUPPORTED' })
    expect(validateCredential).toHaveBeenCalledTimes(1)
    expect(listModels).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()

    const [asset] = await runtime.services.media.pickFiles({
      conversationId: conversation.id,
      existingAssetIds: [],
    })
    await expect(runtime.services.chat.send({
      ...chatInput(conversation.id, 'analyze this image'),
      assetIds: [asset!.id],
      outputType: 'text',
    })).rejects.toMatchObject({ code: 'MODEL_MODALITY_UNSUPPORTED' })
    expect(validateCredential).toHaveBeenCalledTimes(1)
    expect(listModels).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()

    validateCredential.mockRejectedValueOnce({ code: 'MODEL_PROVIDER_ACCESS_DENIED' })
    await expect(runtime.services.chat.send(chatInput(conversation.id, 'forbidden')))
      .rejects.toMatchObject({ code: 'MODEL_PROVIDER_ACCESS_DENIED' })
    expect(stream).not.toHaveBeenCalled()
    await runtime.close()
    const sqlite = new Database(join(root, 'autoforge.sqlite'), { readonly: true })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM provider_usage_events').get())
      .toEqual({ count: 0 })
    sqlite.close()
  })

  it('quarantines media for conversation deletion and preserves it for executions-only clear', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-media-delete-'))
    directories.push(root)
    const source = join(root, 'source.png')
    await writeFile(source, Buffer.from('89504e470d0a1a0a', 'hex'))
    const runtime = createApplicationRuntime({
      authService: createTestAuthService(),
      paths: {
        database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
        projects: join(root, 'projects'), installations: join(root, 'workflows'),
        workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(value),
        decrypt: async (value) => ({ value: value.toString(), shouldReEncrypt: false }),
      },
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [source],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(),
      emitExecution: vi.fn(),
      networkProxy,
      browserWorkspace: createBrowserWorkspace(),
    })

    await authenticate(runtime)
    const deleted = await runtime.services.chat.createConversation()
    await runtime.services.media.pickFiles({
      conversationId: deleted.id,
      existingAssetIds: [],
    })
    const deletedDirectory = join(root, 'media', deleted.id)
    await expect(access(deletedDirectory)).resolves.toBeUndefined()
    await runtime.services.chat.deleteConversation(deleted.id)
    await expect(access(deletedDirectory)).rejects.toMatchObject({ code: 'ENOENT' })

    const preserved = await runtime.services.chat.createConversation()
    await runtime.services.media.pickFiles({
      conversationId: preserved.id,
      existingAssetIds: [],
    })
    const preservedDirectory = join(root, 'media', preserved.id)
    await runtime.services.settings.clearLocalData('executions')
    await expect(access(preservedDirectory)).resolves.toBeUndefined()
    expect(await runtime.services.chat.listConversations()).toHaveLength(1)

    await runtime.services.settings.clearLocalData('all')
    await expect(access(preservedDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await runtime.services.chat.listConversations()).toEqual([])
    await runtime.close()
  })

  it('strictly normalizes and persists generation preferences across restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-preferences-'))
    directories.push(root)
    const options: Parameters<typeof createApplicationRuntime>[0] = {
      authService: createTestAuthService(),
      paths: {
        database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
        projects: join(root, 'projects'), installations: join(root, 'workflows'),
        workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(value),
        decrypt: async (value) => ({ value: value.toString(), shouldReEncrypt: false }),
      },
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(),
      emitExecution: vi.fn(),
      networkProxy,
      browserWorkspace: createBrowserWorkspace(),
    }
    const runtime = createApplicationRuntime(options)
    await authenticate(runtime)
    const conversation = await runtime.services.chat.createConversation()
    await expect(runtime.services.chat.updateGenerationPreferences(
      conversation.id,
      {
        outputType: 'image',
        models: { image: 'openrouter/image' },
        generation: {
          image: { count: 1 },
          audio: {},
          video: {},
        },
      } as Parameters<typeof runtime.services.chat.updateGenerationPreferences>[1],
    )).resolves.toEqual({
      outputType: 'image',
      models: { image: 'openrouter/image' },
      generation: {
        image: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
        audio: { format: 'mp3' },
        video: { durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false },
      },
    })
    await expect(runtime.services.chat.updateGenerationPreferences(
      conversation.id,
      {
        ...(await runtime.services.chat.getGenerationPreferences(conversation.id)),
        unexpected: true,
      } as never,
    )).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(runtime.services.chat.getGenerationPreferences('missing_conversation'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(runtime.services.chat.updateGenerationPreferences(
      'missing_conversation',
      await runtime.services.chat.getGenerationPreferences(conversation.id),
    )).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await runtime.close()

    const restarted = createApplicationRuntime(options)
    await expect(restarted.services.chat.getGenerationPreferences(conversation.id))
      .resolves.toMatchObject({
        outputType: 'image',
        models: { image: 'openrouter/image' },
      })
    await restarted.close()
  })

  it('cancels synchronous media work before closing and rejects unsafe deletion while it is active', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-cancel-media-'))
    directories.push(root)
    const generateImage = vi.fn(({ signal }: { signal?: AbortSignal }) => (
      new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject({ code: 'CANCELLED' }), { once: true })
      })
    ))
    const runtime = createApplicationRuntime({
      authService: createTestAuthService(),
      paths: {
        database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
        projects: join(root, 'projects'), installations: join(root, 'workflows'),
        workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(value),
        decrypt: async (value) => ({ value: value.toString(), shouldReEncrypt: false }),
      },
      modelProviders: snapshotProviders({
        openrouter: {
          listModels: vi.fn(async () => [imageModelInfo('openrouter/image')]),
          validateCredential: vi.fn(async () => ({ valid: true })),
          stream: vi.fn(async function* () {
            yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
          }),
          generateImage,
        },
      }),
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(),
      emitExecution: vi.fn(),
      networkProxy,
      browserWorkspace: createBrowserWorkspace(),
    })
    await authenticate(runtime)
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.update({
      activeProvider: 'openrouter',
      defaultModels: {
        deepseek: { text: 'deepseek-v4-flash' },
        openrouter: { image: 'openrouter/image' },
      },
    })
    const conversation = await runtime.services.chat.createConversation()
    const { requestId } = await runtime.services.chat.send({
      ...chatInput(conversation.id, 'generate until cancelled'),
      outputType: 'image',
    })
    await vi.waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1))
    await expect(runtime.services.chat.deleteConversation(conversation.id))
      .rejects.toMatchObject({ code: 'CONFLICT' })

    await runtime.services.chat.cancel(requestId)
    await runtime.close()
  })

  it('excludes conversation deletion while a send is still in provider preflight', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-delete-preflight-'))
    directories.push(root)
    let finishValidation!: (value: { valid: boolean }) => void
    const validateCredential = vi.fn(() => new Promise<{ valid: boolean }>((resolve) => {
      finishValidation = resolve
    }))
    const runtime = createApplicationRuntime({
      authService: createTestAuthService(),
      paths: {
        database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
        projects: join(root, 'projects'), installations: join(root, 'workflows'),
        workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(value),
        decrypt: async (value) => ({ value: value.toString(), shouldReEncrypt: false }),
      },
      modelProviders: snapshotProviders({
        deepseek: {
          listModels: vi.fn(async () => [modelInfo('deepseek-v4-flash', 'DeepSeek')]),
          validateCredential,
          stream: vi.fn(async function* () {
            yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
          }),
        },
      }),
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(),
      emitExecution: vi.fn(),
      networkProxy,
      browserWorkspace: createBrowserWorkspace(),
    })
    await authenticate(runtime)
    await runtime.services.settings.saveProviderApiKey('deepseek', 'sk-deepseek')
    const conversation = await runtime.services.chat.createConversation()
    const sending = runtime.services.chat.send(chatInput(conversation.id, 'preflight'))
    await vi.waitFor(() => expect(validateCredential).toHaveBeenCalledTimes(1))

    await expect(runtime.services.chat.deleteConversation(conversation.id))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    let closed = false
    const closing = runtime.close().then(() => { closed = true })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(closed).toBe(false)
    finishValidation({ valid: true })
    await sending
    await closing
  })

  it('uses the video runner for pause/resume and stops polling timers before database close', async () => {
    vi.useFakeTimers()
    try {
      const root = await mkdtemp(join(tmpdir(), 'autoforge-application-video-stop-'))
      directories.push(root)
      const pollVideo = vi.fn(async () => ({ status: 'pending' as const }))
      const runtime = createApplicationRuntime({
        authService: createTestAuthService(),
        paths: {
          database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
          projects: join(root, 'projects'), installations: join(root, 'workflows'),
          workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
        },
        safeStorage: {
          isAvailable: async () => true,
          encrypt: async (value) => Buffer.from(value),
          decrypt: async (value) => ({ value: value.toString(), shouldReEncrypt: false }),
        },
        modelProviders: snapshotProviders({
          openrouter: {
            listModels: vi.fn(async () => [videoModelInfo('openrouter/video')]),
            validateCredential: vi.fn(async () => ({ valid: true })),
            stream: vi.fn(async function* () {
              yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
            }),
            submitVideo: vi.fn(async () => ({
              providerJobId: 'provider_video_pause',
              status: 'pending' as const,
            })),
            pollVideo,
          },
        }),
        chooseProjectDirectory: async () => undefined,
        chooseMediaFiles: async () => [],
        readClipboardImage: () => undefined,
        chooseMediaSavePath: async () => undefined,
        revealPath: () => undefined,
        openExternal: async () => undefined,
        emitChat: vi.fn(),
        emitExecution: vi.fn(),
        networkProxy,
        browserWorkspace: createBrowserWorkspace(),
      })
      await authenticate(runtime)
      await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
      await runtime.services.settings.update({
        activeProvider: 'openrouter',
        defaultModels: {
          deepseek: { text: 'deepseek-v4-flash' },
          openrouter: { video: 'openrouter/video' },
        },
      })
      const conversation = await runtime.services.chat.createConversation()
      const { requestId } = await runtime.services.chat.send({
        ...chatInput(conversation.id, 'make a video'),
        outputType: 'video',
      })
      await expect(runtime.services.chat.deleteConversation(conversation.id))
        .rejects.toMatchObject({ code: 'CONFLICT' })
      await runtime.services.media.pauseVideoJob(requestId)
      await runtime.services.media.resumeVideoJob(requestId)
      await runtime.services.media.pauseVideoJob(requestId)
      await runtime.services.chat.deleteConversation(conversation.id)

      await runtime.close()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(pollVideo).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers persisted video polling only after restart recovery runs', async () => {
    vi.useFakeTimers()
    try {
      const root = await mkdtemp(join(tmpdir(), 'autoforge-application-video-recover-'))
      directories.push(root)
      const pollVideo = vi.fn(async () => ({ status: 'pending' as const }))
      const provider = {
        listModels: vi.fn(async () => [videoModelInfo('openrouter/video')]),
        validateCredential: vi.fn(async () => ({ valid: true })),
        stream: vi.fn(async function* () {
          yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
        }),
        submitVideo: vi.fn(async () => ({
          providerJobId: 'provider_video_recover',
          status: 'pending' as const,
        })),
        pollVideo,
      }
      const options: Parameters<typeof createApplicationRuntime>[0] = {
        authService: createTestAuthService(),
        paths: {
          database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
          projects: join(root, 'projects'), installations: join(root, 'workflows'),
          workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
        },
        safeStorage: {
          isAvailable: async () => true,
          encrypt: async (value) => Buffer.from(value),
          decrypt: async (value) => ({ value: value.toString(), shouldReEncrypt: false }),
        },
        modelProviders: { openrouter: snapshotProvider('openrouter', provider) },
        chooseProjectDirectory: async () => undefined,
        chooseMediaFiles: async () => [],
        readClipboardImage: () => undefined,
        chooseMediaSavePath: async () => undefined,
        revealPath: () => undefined,
        openExternal: async () => undefined,
        emitChat: vi.fn(),
        emitExecution: vi.fn(),
        networkProxy,
        browserWorkspace: createBrowserWorkspace(),
      }
      const runtime = createApplicationRuntime(options)
      await authenticate(runtime)
      await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
      await runtime.services.settings.update({
        activeProvider: 'openrouter',
        defaultModels: {
          deepseek: { text: 'deepseek-v4-flash' },
          openrouter: { video: 'openrouter/video' },
        },
      })
      const conversation = await runtime.services.chat.createConversation()
      await runtime.services.chat.send({
        ...chatInput(conversation.id, 'recover this video'),
        outputType: 'video',
      })
      await runtime.close()

      const restarted = createApplicationRuntime(options)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(pollVideo).not.toHaveBeenCalled()
      await restarted.recover()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(pollVideo).toHaveBeenCalledWith('provider_video_recover', expect.any(AbortSignal))
      await restarted.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails interrupted non-video generation blocks during application recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-image-recover-'))
    directories.push(root)
    const databasePath = join(root, 'autoforge.sqlite')
    const database = openAppDatabase(databasePath)
    database.conversations.insert({ id: 'conversation_interrupted_image', title: 'Interrupted' })
    database.messages.insert({
      id: 'assistant_interrupted_image',
      conversationId: 'conversation_interrupted_image',
      role: 'assistant',
      blocks: [{
        type: 'media_generation',
        blockId: 'block_interrupted_image',
        jobId: 'request_interrupted_image',
        kind: 'image',
        status: 'in_progress',
      }],
      createdAt: 1,
    })
    database.chatRuns.insert({
      id: 'run_interrupted_image',
      conversationId: 'conversation_interrupted_image',
      requestId: 'request_interrupted_image',
      model: 'openrouter/image',
      status: 'running',
      startedAt: 1,
    })
    database.close()

    const runtime = createApplicationRuntime({
      authService: createTestAuthService(),
      paths: {
        database: databasePath, data: root, logs: join(root, 'logs'),
        projects: join(root, 'projects'), installations: join(root, 'workflows'),
        workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(value),
        decrypt: async (value) => ({ value: value.toString(), shouldReEncrypt: false }),
      },
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(),
      emitExecution: vi.fn(),
      networkProxy,
      browserWorkspace: createBrowserWorkspace(),
    })
    await authenticate(runtime)
    await runtime.services.chat.listConversations()
    await runtime.recover()
    await expect(runtime.services.chat.listMessages('conversation_interrupted_image'))
      .resolves.toEqual([
        expect.objectContaining({
          blocks: [{
            type: 'media_generation',
            blockId: 'block_interrupted_image',
            jobId: 'request_interrupted_image',
            kind: 'image',
            status: 'failed',
            errorCode: 'MEDIA_GENERATION_FAILED',
          }],
        }),
      ])
    await runtime.close()
  })

  it('persists both provider credentials in the local database across a restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-'))
    directories.push(root)
    const openrouter = {
      listModels: vi.fn(async () => []),
      validateCredential: vi.fn(async () => ({ valid: true })),
      stream: vi.fn(async function* () {
        yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
      }),
    }
    const deepseek = {
      listModels: vi.fn(async () => []),
      validateCredential: vi.fn(async () => ({ valid: true })),
      stream: vi.fn(async function* () {
        yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
      }),
    }
    const options: Parameters<typeof createApplicationRuntime>[0] = {
      authService: createTestAuthService(),
      paths: {
        database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
        projects: join(root, 'projects'), installations: join(root, 'workflows'),
        workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(`encrypted:${value}`),
        decrypt: async (value) => ({
          value: value.toString().replace(/^encrypted:/, ''),
          shouldReEncrypt: false,
        }),
      },
      modelProviders: {
        openrouter: snapshotProvider('openrouter', openrouter),
        deepseek: snapshotProvider('deepseek', deepseek),
      },
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(),
      emitExecution: vi.fn(),
      networkProxy,
      browserWorkspace: createBrowserWorkspace(),
    }
    const runtime = createApplicationRuntime(options)
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.saveProviderApiKey('deepseek', 'sk-deepseek')
    await runtime.close()

    const database = openAppDatabase(options.paths.database)
    const secretStore = new SecretStore(database.encryptedSecrets, options.safeStorage)
    await expect(secretStore.get('openrouter_api_key')).resolves.toBe('sk-openrouter')
    await expect(secretStore.get('deepseek_api_key')).resolves.toBe('sk-deepseek')
    database.close()

    const restarted = createApplicationRuntime(options)
    await expect(restarted.services.settings.validateProviderCredential('openrouter'))
      .resolves.toMatchObject({ provider: 'openrouter', configured: true, validation: 'valid' })
    await expect(restarted.services.settings.validateProviderCredential('deepseek'))
      .resolves.toMatchObject({ provider: 'deepseek', configured: true, validation: 'valid' })
    await restarted.close()
  })

  it('reports local credential persistence without waiting for online validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-'))
    directories.push(root)
    const validation = new Promise<{ valid: boolean }>(() => undefined)
    const deepseek = {
      listModels: vi.fn(async () => []),
      validateCredential: vi.fn(() => validation),
      stream: vi.fn(async function* () {
        yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
      }),
    }
    const runtime = createApplicationRuntime({
      authService: createTestAuthService(),
      paths: {
        database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
        projects: join(root, 'projects'), installations: join(root, 'workflows'),
        workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(`encrypted:${value}`),
        decrypt: async (value) => ({
          value: value.toString().replace(/^encrypted:/, ''),
          shouldReEncrypt: false,
        }),
      },
      modelProviders: snapshotProviders({
        deepseek,
        openrouter: {
          listModels: vi.fn(async () => []),
          validateCredential: vi.fn(async () => ({ valid: true })),
          stream: vi.fn(async function* () {
            yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
          }),
        },
      }),
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(),
      emitExecution: vi.fn(),
      networkProxy,
      browserWorkspace: createBrowserWorkspace(),
    })
    let status: Awaited<ReturnType<typeof runtime.services.settings.saveProviderApiKey>> | undefined
    void runtime.services.settings.saveProviderApiKey('deepseek', 'sk-deepseek')
      .then((value) => { status = value })

    await vi.waitFor(() => expect(status).toEqual({
      provider: 'deepseek',
      configured: true,
      validation: 'unchecked',
    }))
    expect(deepseek.validateCredential).not.toHaveBeenCalled()
    await runtime.close()
  })

  it('returns project directories required by the developer IPC contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-project-directories-'))
    directories.push(root)
    const runtime = createApplicationRuntime(options(root))
    const project = await runtime.services.developer.createProject('Directory Tree')
    await mkdir(join(project.rootPath, 'docs/nested'), { recursive: true })
    await mkdir(join(project.rootPath, 'node_modules/private-package'), { recursive: true })

    expect(await runtime.services.developer.listProjects()).toEqual([
      expect.objectContaining({
        id: project.id,
        directories: ['docs', 'docs/nested', 'src'],
      }),
    ])

    await runtime.close()
  })

  it('creates workflow manifests that apply to all cities by default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-workflow-cities-'))
    directories.push(root)
    const runtime = createApplicationRuntime(options(root))

    const project = await runtime.services.developer.createProject('All Cities')
    const manifest = JSON.parse(
      await runtime.services.developer.readFile(project.id, 'workflow.json'),
    ) as Record<string, unknown>

    expect(manifest.cities).toEqual([])

    await runtime.close()
  })

  it('marks edited workflow sources unavailable to chat until an explicit successful build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-workflow-chat-availability-'))
    directories.push(root)
    const runtime = createApplicationRuntime(options(root))

    const project = await runtime.services.developer.createProject('Chat Availability')
    expect((await runtime.services.developer.listProjects())[0]).toMatchObject({
      id: project.id,
      status: 'new',
      chatAvailability: 'not_built',
    })

    await runtime.services.developer.build(project.id)
    expect((await runtime.services.developer.listProjects())[0]).toMatchObject({
      id: project.id,
      status: 'ready',
      chatAvailability: 'ready',
    })

    await runtime.services.developer.writeFile(project.id, 'src/index.ts', "import { defineWorkflow } from '@autoforge/workflow-sdk'\nexport default defineWorkflow({ run: async () => ({ changed: true }) })\n")
    expect((await runtime.services.developer.listProjects())[0]).toMatchObject({
      id: project.id,
      status: 'new',
      chatAvailability: 'unbuilt_changes',
    })

    await runtime.services.developer.build(project.id)
    expect((await runtime.services.developer.listProjects())[0]).toMatchObject({
      id: project.id,
      status: 'ready',
      chatAvailability: 'ready',
    })

    const manifest = JSON.parse(await runtime.services.developer.readFile(project.id, 'workflow.json')) as Record<string, unknown>
    manifest.description = 'Edited manifest requires another build'
    await runtime.services.developer.writeFile(project.id, 'workflow.json', `${JSON.stringify(manifest, null, 2)}\n`)
    expect((await runtime.services.developer.listProjects())[0]).toMatchObject({
      id: project.id,
      status: 'new',
      chatAvailability: 'unbuilt_changes',
    })

    await runtime.services.developer.build(project.id)
    expect((await runtime.services.developer.listProjects())[0]).toMatchObject({
      id: project.id,
      status: 'ready',
      chatAvailability: 'ready',
    })

    await runtime.close()
  })

  it('returns the titled first input validation error without starting an execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-workflow-input-error-'))
    directories.push(root)
    const runtime = createApplicationRuntime(options(root))

    await authenticate(runtime)
    const project = await runtime.services.developer.createProject('Input Validation')
    const manifest = JSON.parse(
      await runtime.services.developer.readFile(project.id, 'workflow.json'),
    ) as Record<string, unknown>
    manifest.inputSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['keyword'],
      properties: {
        keyword: { type: 'string', title: '搜索关键词', minLength: 1 },
      },
    }
    await runtime.services.developer.writeFile(project.id, 'workflow.json', `${JSON.stringify(manifest, null, 2)}\n`)

    await expect(runtime.services.developer.run({ projectId: project.id, input: { keyword: '' } }))
      .resolves.toEqual({ validationError: '搜索关键词不能为空' })
    expect(await runtime.services.executions.list()).toEqual([])

    await runtime.close()
  })

  it.each([
    {
      name: 'missing required property',
      inputSchema: { type: 'object', required: ['keyword'], properties: { keyword: { type: 'string', title: '搜索关键词' } } },
      input: {},
      expected: '搜索关键词不能为空',
    },
    {
      name: 'field name fallback instead of parent title',
      inputSchema: { type: 'object', title: '调试参数', required: ['keyword'], properties: { keyword: { type: 'string' } } },
      input: {},
      expected: 'keyword不能为空',
    },
    {
      name: 'first of multiple errors',
      inputSchema: {
        type: 'object',
        required: ['keyword', 'region'],
        properties: {
          keyword: { type: 'string', title: '搜索关键词' },
          region: { type: 'string', title: '地区' },
        },
      },
      input: {},
      expected: '搜索关键词不能为空',
    },
    {
      name: 'local reference title',
      inputSchema: {
        type: 'object',
        properties: { amount: { $ref: '#/$defs/amount' } },
        $defs: { amount: { type: 'number', title: '金额' } },
      },
      input: { amount: 'invalid' },
      expected: '金额必须是数字',
    },
    {
      name: 'required local reference title',
      inputSchema: {
        type: 'object',
        required: ['amount'],
        properties: { amount: { $ref: '#/$defs/amount' } },
        $defs: { amount: { type: 'number', title: '金额' } },
      },
      input: {},
      expected: '金额不能为空',
    },
    {
      name: 'pattern property title',
      inputSchema: {
        type: 'object',
        patternProperties: { '^x-': { type: 'number', title: '扩展值' } },
      },
      input: { 'x-value': 'invalid' },
      expected: '扩展值必须是数字',
    },
    {
      name: 'combinator parent title',
      inputSchema: {
        type: 'object',
        properties: { value: { title: '值', anyOf: [{ type: 'number' }, { type: 'boolean' }] } },
      },
      input: { value: 'invalid' },
      expected: '值必须是数字',
    },
    {
      name: 'minimum string length',
      inputSchema: { type: 'object', properties: { keyword: { type: 'string', title: '搜索关键词', minLength: 2 } } },
      input: { keyword: 'a' },
      expected: '搜索关键词长度不能少于 2 个字符',
    },
    {
      name: 'maximum string length',
      inputSchema: { type: 'object', properties: { keyword: { type: 'string', title: '搜索关键词', maxLength: 2 } } },
      input: { keyword: 'abc' },
      expected: '搜索关键词长度不能超过 2 个字符',
    },
    {
      name: 'string format',
      inputSchema: { type: 'object', properties: { email: { type: 'string', title: '邮箱', format: 'email' } } },
      input: { email: 'invalid' },
      expected: '邮箱格式不正确',
    },
    {
      name: 'string pattern',
      inputSchema: { type: 'object', properties: { code: { type: 'string', title: '编码', pattern: '^[A-Z]+$' } } },
      input: { code: 'abc' },
      expected: '编码格式不正确',
    },
    {
      name: 'minimum number',
      inputSchema: { type: 'object', properties: { age: { type: 'number', title: '年龄', minimum: 18 } } },
      input: { age: 17 },
      expected: '年龄不能小于 18',
    },
    {
      name: 'maximum number',
      inputSchema: { type: 'object', properties: { age: { type: 'number', title: '年龄', maximum: 120 } } },
      input: { age: 121 },
      expected: '年龄不能大于 120',
    },
    {
      name: 'exclusive minimum number',
      inputSchema: { type: 'object', properties: { age: { type: 'number', title: '年龄', exclusiveMinimum: 18 } } },
      input: { age: 18 },
      expected: '年龄必须大于 18',
    },
    {
      name: 'exclusive maximum number',
      inputSchema: { type: 'object', properties: { age: { type: 'number', title: '年龄', exclusiveMaximum: 120 } } },
      input: { age: 120 },
      expected: '年龄必须小于 120',
    },
    {
      name: 'number multiple',
      inputSchema: { type: 'object', properties: { count: { type: 'number', title: '数量', multipleOf: 5 } } },
      input: { count: 12 },
      expected: '数量必须是 5 的倍数',
    },
    {
      name: 'integer type',
      inputSchema: { type: 'object', properties: { count: { type: 'integer', title: '数量' } } },
      input: { count: 1.5 },
      expected: '数量必须是整数',
    },
    {
      name: 'enum value',
      inputSchema: { type: 'object', properties: { region: { type: 'string', title: '地区', enum: ['北京', '上海'] } } },
      input: { region: '杭州' },
      expected: '地区必须选择允许的值',
    },
    {
      name: 'constant value',
      inputSchema: { type: 'object', properties: { region: { type: 'string', title: '地区', const: '上海' } } },
      input: { region: '北京' },
      expected: '地区必须选择允许的值',
    },
    {
      name: 'additional property',
      inputSchema: { type: 'object', title: '参数', additionalProperties: false, properties: {} },
      input: { extra: true },
      expected: 'extra是不支持的字段',
    },
    {
      name: 'minimum array items',
      inputSchema: { type: 'object', properties: { tags: { type: 'array', title: '标签', minItems: 2 } } },
      input: { tags: ['a'] },
      expected: '标签至少需要 2 项',
    },
    {
      name: 'maximum array items',
      inputSchema: { type: 'object', properties: { tags: { type: 'array', title: '标签', maxItems: 1 } } },
      input: { tags: ['a', 'b'] },
      expected: '标签最多允许 1 项',
    },
    {
      name: 'unique array items',
      inputSchema: { type: 'object', properties: { tags: { type: 'array', title: '标签', uniqueItems: true } } },
      input: { tags: ['a', 'a'] },
      expected: '标签不能包含重复项',
    },
    {
      name: 'minimum object properties',
      inputSchema: { type: 'object', properties: { contact: { type: 'object', title: '联系方式', minProperties: 1 } } },
      input: { contact: {} },
      expected: '联系方式至少需要 1 个字段',
    },
    {
      name: 'maximum object properties',
      inputSchema: { type: 'object', properties: { contact: { type: 'object', title: '联系方式', maxProperties: 1 } } },
      input: { contact: { phone: '1', email: 'a' } },
      expected: '联系方式最多允许 1 个字段',
    },
    {
      name: 'nested property',
      inputSchema: {
        type: 'object',
        properties: {
          address: {
            type: 'object',
            properties: { postcode: { type: 'string', title: '邮编', minLength: 5 } },
          },
        },
      },
      input: { address: { postcode: '12' } },
      expected: '邮编长度不能少于 5 个字符',
    },
    {
      name: 'nested field fallback instead of parent title',
      inputSchema: {
        type: 'object',
        properties: {
          address: {
            type: 'object',
            title: '地址',
            properties: { postcode: { type: 'string', minLength: 5 } },
          },
        },
      },
      input: { address: { postcode: '12' } },
      expected: 'postcode长度不能少于 5 个字符',
    },
    {
      name: 'nested array property',
      inputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { code: { type: 'string', title: '条目编码', minLength: 3 } },
            },
          },
        },
      },
      input: { items: [{ code: 'a' }] },
      expected: '条目编码长度不能少于 3 个字符',
    },
    {
      name: 'safe fallback',
      inputSchema: { type: 'object', properties: { token: { title: '令牌', not: { const: 'secret' } } } },
      input: { token: 'secret' },
      expected: '令牌输入无效',
    },
    {
      name: 'blank field name fallback',
      inputSchema: { type: 'object', required: ['   '], properties: { '   ': { type: 'string' } } },
      input: {},
      expected: '输入内容不能为空',
    },
  ])('formats the first $name validation error', async ({ inputSchema, input, expected }) => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-workflow-input-keyword-'))
    directories.push(root)
    const runtime = createApplicationRuntime(options(root))

    await authenticate(runtime)
    const project = await runtime.services.developer.createProject('Input Keyword')
    const manifest = JSON.parse(
      await runtime.services.developer.readFile(project.id, 'workflow.json'),
    ) as Record<string, unknown>
    manifest.inputSchema = inputSchema
    await runtime.services.developer.writeFile(project.id, 'workflow.json', `${JSON.stringify(manifest, null, 2)}\n`)

    await expect(runtime.services.developer.run({ projectId: project.id, input }))
      .resolves.toEqual({ validationError: expected })
    expect(await runtime.services.executions.list()).toEqual([])

    await runtime.close()
  })

  it('bounds fallback field names to the developer run IPC response contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-workflow-input-long-field-'))
    directories.push(root)
    const runtime = createApplicationRuntime(options(root))

    await authenticate(runtime)
    const project = await runtime.services.developer.createProject('Long Input Field')
    const manifest = JSON.parse(
      await runtime.services.developer.readFile(project.id, 'workflow.json'),
    ) as Record<string, unknown>
    const field = 'x'.repeat(600)
    manifest.inputSchema = {
      type: 'object',
      required: [field],
      properties: { [field]: { type: 'string' } },
    }
    await runtime.services.developer.writeFile(project.id, 'workflow.json', `${JSON.stringify(manifest, null, 2)}\n`)

    const result = await runtime.services.developer.run({ projectId: project.id, input: {} })
    expect(developerRunResultSchema.safeParse(result).success).toBe(true)
    expect(result).toEqual({ validationError: `${'x'.repeat(100)}不能为空` })

    await runtime.close()
  })

  it('composes real persistence-backed DesktopAPI services and recovers before use', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-'))
    directories.push(root)
    const openExternal = vi.fn().mockResolvedValue(undefined)
    const chatEvents: Array<{ type: string; status?: string }> = []
    const runtime = createApplicationRuntime({
      authService: createTestAuthService(),
      paths: {
        database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
        projects: join(root, 'projects'), installations: join(root, 'workflows'),
        workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(value),
        decrypt: async (value) => ({ value: value.toString(), shouldReEncrypt: false }),
      },
      modelProviders: snapshotProviders({ openrouter: {
        listModels: async () => [modelInfo('openrouter/text', 'OpenRouter text')],
        validateCredential: async () => ({ valid: true }),
        stream: async function* () { yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' } },
      } }),
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal,
      emitChat: (event) => { chatEvents.push(event) },
      emitExecution: vi.fn(),
      networkProxy,
      browserWorkspace: createBrowserWorkspace(),
    })

    await authenticate(runtime)
    await runtime.recover()
    await runtime.services.settings.update({ activeProvider: 'openrouter' })
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    const applicationSettings = await runtime.services.settings.get()
    await runtime.services.settings.update({
      defaultModels: {
        ...applicationSettings.defaultModels,
        openrouter: { text: 'openrouter/text' },
      },
    })
    const conversation = await runtime.services.chat.createConversation()
    expect(await runtime.services.chat.listConversations()).toEqual([conversation])
    expect(await runtime.services.chat.listMessages(conversation.id)).toEqual([])
    expect(await runtime.services.chat.renameConversation(conversation.id, 'Renamed')).toMatchObject({ title: 'Renamed' })
    await runtime.services.chat.send(chatInput(conversation.id, 'persist me'))
    for (let index = 0; index < 30 && !chatEvents.some((event) => event.status === 'completed'); index += 1) await Promise.resolve()
    expect(await runtime.services.chat.listMessages(conversation.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', blocks: [{ type: 'text', text: 'persist me' }] }),
      expect.objectContaining({ role: 'assistant' }),
    ]))
    expect(await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-local'))
      .toMatchObject({ provider: 'openrouter', configured: true, validation: 'unchecked' })
    const longNameProject = await runtime.services.developer.createProject(`${'a'.repeat(47)} b`)
    expect(longNameProject.name).toBe(`${'a'.repeat(47)} b`)
    await mkdir(join(longNameProject.rootPath, 'node_modules/private-package'), { recursive: true })
    await writeFile(join(longNameProject.rootPath, 'node_modules/private-package/index.js'), 'generated dependency')
    expect(await runtime.services.developer.listProjects()).toEqual([
      expect.objectContaining({ id: longNameProject.id, files: expect.arrayContaining(['src/index.ts', 'workflow.json']) }),
    ])
    expect((await runtime.services.developer.listProjects())[0]?.files.some((file) => file.startsWith('node_modules/'))).toBe(false)
    const manifest = JSON.parse(await runtime.services.developer.readFile(longNameProject.id, 'workflow.json')) as Record<string, unknown>
    manifest.inputSchema = {
      type: 'object', additionalProperties: false, required: ['keyword'],
      properties: { keyword: { type: 'string', minLength: 1 } },
    }
    await runtime.services.developer.writeFile(longNameProject.id, 'workflow.json', JSON.stringify(manifest))
    await expect(runtime.services.developer.run({ projectId: longNameProject.id, input: {} }))
      .resolves.toEqual({ validationError: 'keyword不能为空' })
    await runtime.services.system.openExternal('https://example.com/')
    expect(openExternal).toHaveBeenCalledWith('https://example.com/')

    for (const domain of ['chat', 'workflows', 'developer', 'executions', 'permissions', 'settings', 'system'] as const) {
      expect(Object.values(runtime.services[domain]).every((member) => typeof member === 'function')).toBe(true)
    }
    await runtime.close()

    const restarted = createApplicationRuntime({
      authService: createTestAuthService(),
      paths: {
        database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
        projects: join(root, 'projects'), installations: join(root, 'workflows'),
        workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(value),
        decrypt: async (value) => ({ value: value.toString(), shouldReEncrypt: false }),
      },
      modelProviders: snapshotProviders({ openrouter: {
        listModels: async () => [modelInfo('openrouter/text', 'OpenRouter text')], validateCredential: async () => ({ valid: true }),
        stream: async function* () { yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' } },
      } }),
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal,
      emitChat: vi.fn(), emitExecution: vi.fn(),
      networkProxy,
      browserWorkspace: createBrowserWorkspace(),
    })
    await authenticate(restarted)
    await restarted.recover()
    expect(await restarted.services.chat.listMessages(conversation.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', blocks: [{ type: 'text', text: 'persist me' }] }),
    ]))
    await restarted.close()
  })

  it('rejects conversation cleanup during a streaming chat and succeeds after terminalization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-'))
    directories.push(root)
    let finishStream!: () => void
    const streamFinished = new Promise<void>((resolve) => { finishStream = resolve })
    const chatEvents: Array<{ type: string; status?: string }> = []
    const runtime = createApplicationRuntime({
      authService: createTestAuthService(),
      paths: {
        database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
        projects: join(root, 'projects'), installations: join(root, 'workflows'),
        workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(value),
        decrypt: async (value) => ({ value: value.toString(), shouldReEncrypt: false }),
      },
      modelProviders: snapshotProviders({ openrouter: {
        listModels: async () => [modelInfo('openrouter/text', 'OpenRouter text')], validateCredential: async () => ({ valid: true }),
        stream: async function* () {
          await streamFinished
          yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
        },
      } }),
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: (event) => { chatEvents.push(event) },
      emitExecution: vi.fn(),
      networkProxy,
      browserWorkspace: createBrowserWorkspace(),
    })
    await authenticate(runtime)
    await runtime.services.settings.update({ activeProvider: 'openrouter' })
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    const cleanupSettings = await runtime.services.settings.get()
    await runtime.services.settings.update({
      defaultModels: {
        ...cleanupSettings.defaultModels,
        openrouter: { text: 'openrouter/text' },
      },
    })
    const conversation = await runtime.services.chat.createConversation()
    await runtime.services.chat.send(chatInput(conversation.id, 'hello'))

    await expect(runtime.services.settings.clearLocalData('conversations'))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(runtime.services.workflows.remove('workflow.active', '1.0.0'))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await runtime.services.chat.listConversations()).toHaveLength(1)

    finishStream()
    for (let index = 0; index < 20 && !chatEvents.some((event) => event.status === 'completed'); index += 1) {
      await Promise.resolve()
    }
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    await runtime.services.settings.clearLocalData('conversations')
    expect(await runtime.services.chat.listConversations()).toEqual([])
    await runtime.close()
  })

  it('atomically excludes maintenance from starts and active execution or browser work', () => {
    const gate = new MaintenanceGate()
    const releaseStart = gate.beginStart()
    const clear = vi.fn()
    expect(() => gate.clearLocalData(() => false, clear)).toThrow(expect.objectContaining({ code: 'CONFLICT' }))
    expect(clear).not.toHaveBeenCalled()
    releaseStart()

    let executionActive = true
    let browserActive = true
    expect(() => gate.clearLocalData(() => executionActive || browserActive, clear))
      .toThrow(expect.objectContaining({ code: 'CONFLICT' }))
    expect(clear).not.toHaveBeenCalled()

    executionActive = false
    browserActive = false
    gate.clearLocalData(() => false, () => {
      expect(() => gate.beginStart()).toThrow(expect.objectContaining({ code: 'CONFLICT' }))
      clear()
    })
    expect(clear).toHaveBeenCalledTimes(1)
  })

  it('keeps a removal-style exclusive operation atomic against a new start', async () => {
    const gate = new MaintenanceGate()
    let finish!: () => void
    const operation = gate.runExclusive(() => false, () => new Promise<void>((resolve) => { finish = resolve }))
    expect(() => gate.beginStart()).toThrow(expect.objectContaining({ code: 'CONFLICT' }))
    finish()
    await operation
    const release = gate.beginStart()
    release()
  })

  it('drains an in-progress exclusive operation before shutdown admission closes', async () => {
    const gate = new MaintenanceGate()
    let finish!: () => void
    const operation = gate.runExclusive(
      () => false,
      () => new Promise<void>((resolve) => { finish = resolve }),
    )
    let drained = false
    const draining = gate.stopAndDrain().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)

    finish()
    await operation
    await draining
    expect(() => gate.beginStart()).toThrow(expect.objectContaining({ code: 'CONFLICT' }))
  })

  it('runs an authenticated development workflow through browser.open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-browser-run-'))
    directories.push(root)
    const executionEvents: ExecutionEvent[] = []
    const baseOptions = options(root, {
      emitExecution: (event) => { executionEvents.push(event) },
    })
    const runtime = createApplicationRuntime({
      ...baseOptions,
      paths: {
        ...baseOptions.paths,
        workflowRunner: join(import.meta.dirname, '../workers/workflow-runner.ts'),
      },
      browserWorkspace: createBrowserWorkspace(),
    } as RuntimeOptions)

    try {
      await authenticate(runtime)
      const project = await runtime.services.developer.createProject('Browser Run')
      const manifest = JSON.parse(await runtime.services.developer.readFile(project.id, 'workflow.json')) as Record<string, unknown>
      manifest.permissions = [{ capability: 'browser.open', scope: { origins: ['https://example.com'] } }]
      await runtime.services.developer.writeFile(project.id, 'workflow.json', `${JSON.stringify(manifest, null, 2)}\n`)
      await runtime.services.developer.writeFile(project.id, 'src/index.ts', [
        "import { defineWorkflow } from '@autoforge/workflow-sdk'",
        "export default defineWorkflow({ async run(ctx) { await ctx.browser.open('https://example.com/path'); return { ok: true } } })",
      ].join('\n'))

      const runResult = await runtime.services.developer.run({ projectId: project.id, input: {} })
      if (!('executionId' in runResult)) throw new Error(runResult.validationError)
      const { executionId } = runResult
      await vi.waitFor(() => {
        expect(executionEvents.some((event) => event.type === 'approval_required'
          && event.executionId === executionId)).toBe(true)
      })
      const approval = executionEvents.find((event): event is Extract<ExecutionEvent, { type: 'approval_required' }> => (
        event.type === 'approval_required' && event.executionId === executionId
      ))!
      await runtime.services.executions.decide({
        executionId,
        permissionIndex: approval.permissionIndex,
        scopeHash: approval.scopeHash,
        decision: 'once',
      })

      await vi.waitFor(async () => {
        expect(await runtime.services.executions.get(executionId)).toMatchObject({
          status: 'completed',
          output: { ok: true },
        })
      })
    } finally {
      await runtime.close()
    }
  })

  it('runs the exact development project even when an installed workflow has the same identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-'))
    directories.push(root)
    let markCleanupStarted!: () => void
    let finishCleanup!: () => void
    const cleanupStarted = new Promise<void>((resolve) => { markCleanupStarted = resolve })
    const cleanupFinished = new Promise<void>((resolve) => { finishCleanup = resolve })
    const runtime = createApplicationRuntime({
      authService: createTestAuthService(),
      paths: {
        database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
        projects: join(root, 'projects'), installations: join(root, 'workflows'),
        workflowRunner: join(import.meta.dirname, '../workers/workflow-runner.ts'), temporary: root,
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(value),
        decrypt: async (value) => ({ value: value.toString(), shouldReEncrypt: false }),
      },
      modelProviders: snapshotProviders({ openrouter: {
        listModels: async () => [], validateCredential: async () => ({ valid: true }),
        stream: async function* () { yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' } },
      } }),
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(), emitExecution: vi.fn(),
      networkProxy,
      browserWorkspace: createBrowserWorkspace(),
      removeExecutionTemporaryDirectory: async (path: string) => {
        markCleanupStarted()
        await cleanupFinished
        await rm(path, { recursive: true, force: true })
      },
    })
    await authenticate(runtime)
    const installedProject = await runtime.services.developer.createProject('Installed Debug Source')
    const selectedProject = await runtime.services.developer.createProject('Selected Debug Source')
    for (const [projectId, marker] of [[installedProject.id, 'installed'], [selectedProject.id, 'selected']] as const) {
      const manifest = JSON.parse(await runtime.services.developer.readFile(projectId, 'workflow.json')) as Record<string, unknown>
      Object.assign(manifest, { id: 'debug.same-identity', version: '1.0.0', permissions: [] })
      await runtime.services.developer.writeFile(projectId, 'workflow.json', `${JSON.stringify(manifest, null, 2)}\n`)
      await runtime.services.developer.writeFile(projectId, 'src/index.ts', [
        "import { defineWorkflow } from '@autoforge/workflow-sdk'",
        `export default defineWorkflow({ async run() { return { marker: '${marker}' } } })`,
      ].join('\n'))
    }
    await runtime.services.developer.build(installedProject.id)
    await runtime.services.workflows.installProject(installedProject.id)

    const runResult = await runtime.services.developer.run({ projectId: selectedProject.id, input: {} })
    if (!('executionId' in runResult)) throw new Error(runResult.validationError)
    const { executionId } = runResult
    let execution = await runtime.services.executions.get(executionId)
    for (let attempt = 0; attempt < 100 && !['completed', 'failed', 'cancelled'].includes(execution.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      execution = await runtime.services.executions.get(executionId)
    }

    expect(execution.status).toBe('completed')
    expect(execution.output).toEqual({ marker: 'selected' })
    await cleanupStarted
    let closed = false
    const closing = runtime.close().then(() => { closed = true })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(closed).toBe(false)
    finishCleanup()
    await closing
  })
})
