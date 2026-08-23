import { randomUUID, X509Certificate } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  app,
  BaseWindow,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  net,
  protocol,
  session,
  WebContentsView,
  type Certificate,
  type Event,
} from 'electron'
import {
  chatEventSchema,
  executionEventSchema,
  ipcChannels,
  toSafeAppError,
  type AuthSession,
} from '@autoforge/shared'
import { createApplicationRuntime } from '../main/application.js'
import type { AuthService } from '../main/auth/auth-service.js'
import {
  browserSessionActInputSchema,
  browserSessionHandoffInputSchema,
  browserSessionInspectInputSchema,
  BrowserContinuationToolExecutor,
  type BrowserContinuationRunContext,
  type BrowserContinuationToolName,
  type BrowserContinuationToolResult,
} from '../main/agent/browser-continuation-tool-executor.js'
import type {
  CredentialBoundModelProvider,
} from '../main/chat/model-provider-registry.js'
import type {
  ModelStreamEvent,
  ModelStreamRequest,
} from '../main/chat/model-provider.js'
import { BrowserContinuationRegistry } from '../main/browser/browser-continuation-registry.js'
import type {
  BrowserContinuationBinding,
  BrowserContinuationBindingInput,
} from '../main/browser/browser-continuation-types.js'
import { BrowserPageInspector } from '../main/browser/browser-page-inspector.js'
import { ElectronBrowserWorkspace } from '../main/browser/electron-browser-workspace.js'
import { openAppDatabase } from '../main/database/client.js'
import { registerDesktopIpc } from '../main/ipc/register-ipc.js'
import { createMediaProtocolHandler } from '../main/media/media-protocol.js'
import { NetworkProxyService } from '../main/network/network-proxy-service.js'
import { createSecureWindow } from '../main/window.js'
import {
  browserPermissionMatrix,
  workflowSecurityFingerprint,
} from '../main/workflows/workflow-security-fingerprint.js'

const certificateFingerprint = '0E:B3:8E:EE:8E:72:4A:4C:DF:82:A0:7E:70:A1:75:8E:3E:14:53:C8:DB:92:45:C2:C2:20:89:D4:47:EB:1E:AD'
const offeredBrowserTools = [
  'browser_session_inspect',
  'browser_session_act',
  'browser_session_handoff',
] as const

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing E2E environment variable: ${name}`)
  return value
}

const desktopRoot = requiredEnvironment('AUTOFORGE_E2E_DESKTOP_ROOT')
const repositoryRoot = requiredEnvironment('AUTOFORGE_E2E_REPOSITORY_ROOT')
const userData = requiredEnvironment('AUTOFORGE_E2E_USER_DATA')
const fixtureOrigin = new URL(requiredEnvironment('AUTOFORGE_E2E_FIXTURE_ORIGIN')).origin
const disallowedOrigin = new URL(requiredEnvironment('AUTOFORGE_E2E_DISALLOWED_ORIGIN')).origin
const fixtureProxy = requiredEnvironment('AUTOFORGE_E2E_FIXTURE_PROXY')
const databasePath = join(userData, 'autoforge.sqlite')
const userId = 'e2e_browser_user'
const account = 'E2EBrowser'
const password = 'password-e2e'

if (new URL(fixtureOrigin).protocol !== 'https:' || new URL(disallowedOrigin).protocol !== 'https:') {
  throw new Error('Browser continuation E2E fixtures must use HTTPS')
}

function certificateSha256(certificate: Certificate): string | undefined {
  const candidate = certificate as Certificate & { fingerprint256?: string }
  if (candidate.fingerprint256) return candidate.fingerprint256
  try { return new X509Certificate(candidate.data).fingerprint256 } catch { return undefined }
}

function trustedFixtureCertificate(url: string, certificate: Certificate): boolean {
  let origin: string
  try { origin = new URL(url).origin } catch { return false }
  return (origin === fixtureOrigin || origin === disallowedOrigin)
    && certificateSha256(certificate)?.toUpperCase() === certificateFingerprint
}

app.on('certificate-error', (event, _webContents, url, _error, certificate, callback) => {
  if (!trustedFixtureCertificate(url, certificate)) return callback(false)
  event.preventDefault()
  callback(true)
})
protocol.registerSchemesAsPrivileged([{
  scheme: 'autoforge-media',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}])
app.setPath('userData', userData)

const authenticatedSession: AuthSession = {
  user: { id: userId, account },
  authenticatedAt: new Date(0).toISOString(),
  authorization: {
    role: 'user', capabilities: [], version: 1,
    updatedAt: new Date(0).toISOString(), confirmed: true,
  },
}

function testAuthService(): AuthService {
  let current: AuthSession | null = authenticatedSession
  const requireCurrent = (): AuthSession => {
    if (!current) throw toSafeAppError({ code: 'AUTH_REQUIRED' })
    return current
  }
  return {
    async getSession() { return current },
    async sendOtp() { return { challengeId: 'e2e_challenge', expiresIn: 300 } },
    async verifyOtp() { current = authenticatedSession; return current },
    async cancelOtp() { /* deterministic no-op */ },
    async loginWithPassword(input) {
      if (input.account !== account || input.password !== password) {
        throw toSafeAppError({ code: 'AUTH_INVALID_CREDENTIALS' })
      }
      current = authenticatedSession
      return current
    },
    async updateUserProfile(input) {
      const sessionValue = requireCurrent()
      current = { ...sessionValue, user: { ...sessionValue.user, profile: { ...sessionValue.user.profile, ...input } } }
      return current.user
    },
    async discardSession() { current = null },
    async logout() { current = null },
    async requireSession() { return requireCurrent() },
  }
}

interface CapturedProviderRequest {
  conversationId: string
  serialized: string
}

interface CapturedProviderAttempt {
  conversationId: string
  name: string
  arguments: unknown
  offered: boolean
  afterInspectedPageData: boolean
}

const providerRequests: CapturedProviderRequest[] = []
const providerAttempts: CapturedProviderAttempt[] = []
const executorCalls: Array<{ conversationId: string; name: string }> = []
const highlightEvents: Array<{ conversationId: string; tabId: string; ref: string }> = []
let continuationRegistry: BrowserContinuationRegistry | undefined

const realBrowserToolExecute = BrowserContinuationToolExecutor.prototype.execute
BrowserContinuationToolExecutor.prototype.execute = async function (tool, rawInput, runContext) {
  executorCalls.push({ conversationId: runContext.conversationId, name: tool })
  return realBrowserToolExecute.call(this, tool, rawInput, runContext)
}

function latestConversationId(): string {
  const database = new Database(databasePath, { readonly: true })
  try {
    return (database.prepare(`
      SELECT conversation_id AS conversationId
      FROM chat_runs
      ORDER BY started_at DESC, rowid DESC
      LIMIT 1
    `).get() as { conversationId?: string } | undefined)?.conversationId ?? 'unknown'
  } finally {
    database.close()
  }
}

function lastToolName(request: ModelStreamRequest): string | undefined {
  const assistant = [...request.messages].reverse().find((message) => message.role === 'assistant' && message.tool_calls?.length)
  return assistant?.role === 'assistant' ? assistant.tool_calls?.at(-1)?.function.name : undefined
}

function lastToolContent(request: ModelStreamRequest): string | undefined {
  const message = [...request.messages].reverse().find((candidate) => candidate.role === 'tool')
  return message?.role === 'tool' ? message.content : undefined
}

function currentUserText(request: ModelStreamRequest): string {
  const message = [...request.messages].reverse().find((candidate) => candidate.role === 'user')
  if (!message || message.role !== 'user') return ''
  if (typeof message.content === 'string') return message.content
  return message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
}

function inspectedSnapshot(request: ModelStreamRequest): {
  snapshotId: string
  nodes: Array<{ ref: string; name: string; role: string }>
} | undefined {
  const content = lastToolContent(request)
  if (!content?.includes('UNTRUSTED_BROWSER_PAGE_DATA')) return undefined
  const serialized = content.split('\n').find((line) => line.startsWith('{"kind":'))
  if (!serialized) return undefined
  try {
    const parsed = JSON.parse(serialized) as {
      kind?: string
      data?: { snapshot?: { snapshotId?: string; nodes?: Array<{ ref?: string; name?: string; role?: string }> } }
    }
    const snapshot = parsed.data?.snapshot
    if (parsed.kind !== 'success' || !snapshot?.snapshotId || !Array.isArray(snapshot.nodes)) return undefined
    const nodes = snapshot.nodes
      .filter((node): node is { ref: string; name: string; role: string } => (
        typeof node.ref === 'string' && typeof node.name === 'string' && typeof node.role === 'string'
      ))
    return { snapshotId: snapshot.snapshotId, nodes }
  } catch {
    return undefined
  }
}

function bindingIdFromRequest(request: ModelStreamRequest, conversationId: string): string | undefined {
  const offered = request.tools?.find((tool) => tool.function.name === 'browser_session_inspect')
  const properties = offered?.function.parameters as {
    properties?: { bindingId?: { enum?: unknown[] } }
  } | undefined
  const value = properties?.properties?.bindingId?.enum?.[0]
  if (typeof value === 'string') return value
  return continuationRegistry?.list(userId, conversationId)[0]?.bindingId
}

function validateScriptedTool(
  request: ModelStreamRequest,
  name: BrowserContinuationToolName,
  input: unknown,
): unknown {
  if (!request.tools?.some((tool) => tool.function.name === name)) {
    throw new Error(`Deterministic provider attempted an unoffered tool: ${name}`)
  }
  if (name === 'browser_session_inspect') return browserSessionInspectInputSchema.parse(input)
  if (name === 'browser_session_act') return browserSessionActInputSchema.parse(input)
  return browserSessionHandoffInputSchema.parse(input)
}

function toolCall(
  request: ModelStreamRequest,
  name: BrowserContinuationToolName,
  input: unknown,
): ModelStreamEvent {
  return {
    type: 'tool_call', choiceIndex: 0, index: 0, id: `e2e_${randomUUID()}`,
    name, arguments: validateScriptedTool(request, name, input),
  }
}

function attemptedToolCall(
  request: ModelStreamRequest,
  conversationId: string,
  name: string,
  input: unknown,
): ModelStreamEvent {
  if (!/^[a-z][a-z0-9_]{0,127}$/u.test(name)) throw new Error(`Invalid deterministic tool name: ${name}`)
  const offered = request.tools?.some((tool) => tool.function.name === name) ?? false
  let parsedInput = input
  if (offered && name === 'browser_session_inspect') parsedInput = browserSessionInspectInputSchema.parse(input)
  if (offered && name === 'browser_session_act') parsedInput = browserSessionActInputSchema.parse(input)
  if (offered && name === 'browser_session_handoff') parsedInput = browserSessionHandoffInputSchema.parse(input)
  providerAttempts.push({
    conversationId,
    name,
    arguments: structuredClone(parsedInput),
    offered,
    afterInspectedPageData: inspectedSnapshot(request) !== undefined,
  })
  return {
    type: 'tool_call', choiceIndex: 0, index: 0, id: `e2e_attempt_${randomUUID()}`,
    name, arguments: parsedInput,
  }
}

const deterministicProvider: CredentialBoundModelProvider = {
  async listModels() {
    return [{
      id: 'openrouter/e2e-browser', name: 'E2E Browser',
      inputModalities: ['text' as const], outputModalities: ['text' as const],
      supportsTools: true, generation: {}, contextLength: 128_000,
    }]
  },
  async validateCredential() { return { valid: true } },
  async *stream(request: ModelStreamRequest) {
    const conversationId = latestConversationId()
    const userText = currentUserText(request)
    providerRequests.push({
      conversationId,
      serialized: JSON.stringify({ messages: request.messages, tools: request.tools }),
    })
    const previousTool = lastToolName(request)
    const workflowTool = request.tools?.find((tool) => tool.function.name.startsWith('workflow_'))
    if (userText.includes('E2E_WORKFLOW_OPEN') && !previousTool && workflowTool) {
      yield {
        type: 'tool_call', choiceIndex: 0, index: 0, id: `e2e_workflow_${randomUUID()}`,
        name: workflowTool.function.name, arguments: { input: {} },
      }
      yield { type: 'finish', choiceIndex: 0, reason: 'tool_calls' }
      return
    }
    if (userText.includes('E2E_WORKFLOW_OPEN') && previousTool?.startsWith('workflow_')) {
      yield { type: 'text_delta', choiceIndex: 0, text: '工作流已通过正常执行链打开页面。' }
      yield { type: 'finish', choiceIndex: 0, reason: 'stop' }
      return
    }
    if (!request.tools?.some((tool) => offeredBrowserTools.includes(tool.function.name as typeof offeredBrowserTools[number]))) {
      yield { type: 'text_delta', choiceIndex: 0, text: '未找到当前会话可继续的页面。' }
      yield { type: 'finish', choiceIndex: 0, reason: 'stop' }
      return
    }
    const bindingId = bindingIdFromRequest(request, conversationId)
    if (!bindingId) throw new Error('No exact continuation binding was offered')
    if (!previousTool) {
      yield toolCall(request, 'browser_session_inspect', { bindingId, intent: '读取证件有效期' })
      yield { type: 'finish', choiceIndex: 0, reason: 'tool_calls' }
      return
    }
    if (previousTool === 'browser_session_inspect') {
      const payload = lastToolContent(request) ?? ''
      if (payload.includes('"auth":"required"')) {
        yield toolCall(request, 'browser_session_handoff', { bindingId, reason: 'login' })
        yield { type: 'finish', choiceIndex: 0, reason: 'tool_calls' }
        return
      }
      const page = inspectedSnapshot(request)
      if (!page) throw new Error('The deterministic provider did not receive a real inspected snapshot')
      const finalRef = page.nodes.find((node) => /正式提交/iu.test(node.name))?.ref
      if (userText.includes('E2E_INJECT_OPEN_TAB')) {
        yield attemptedToolCall(request, conversationId, 'browser_session_open_tab', {
          bindingId, url: 'https://attacker.example/open',
        })
        yield { type: 'finish', choiceIndex: 0, reason: 'tool_calls' }
        return
      }
      if (userText.includes('E2E_INJECT_UPLOAD_FILE')) {
        yield attemptedToolCall(request, conversationId, 'browser_session_upload_file', {
          bindingId, ref: finalRef ?? 'missing_ref', path: '/private/e2e.txt',
        })
        yield { type: 'finish', choiceIndex: 0, reason: 'tool_calls' }
        return
      }
      if (userText.includes('E2E_INJECT_RAW_CDP')) {
        yield attemptedToolCall(request, conversationId, 'browser_session_raw_cdp', {
          bindingId, method: 'Network.getAllCookies', params: {},
        })
        yield { type: 'finish', choiceIndex: 0, reason: 'tool_calls' }
        return
      }
      if (userText.includes('E2E_INJECT_DISALLOWED_ORIGIN')) {
        const disallowedRef = page.nodes.find((node) => /未授权来源/iu.test(node.name))?.ref
        if (!disallowedRef) throw new Error('The real inspected snapshot did not contain the injected navigation link')
        yield attemptedToolCall(request, conversationId, 'browser_session_act', {
          bindingId,
          snapshotId: page.snapshotId,
          actions: [{
            type: 'navigate', url: `${disallowedOrigin}/landing`,
            source: { kind: 'page', snapshotId: page.snapshotId, ref: disallowedRef },
          }],
        })
        yield { type: 'finish', choiceIndex: 0, reason: 'tool_calls' }
        return
      }
      if (userText.includes('E2E_DRAFT')) {
        const employerRef = page.nodes.find((node) => /聘用单位/iu.test(node.name) && node.role === 'textbox')?.ref
        const saveRef = page.nodes.find((node) => /^保存草稿$/iu.test(node.name) && node.role === 'button')?.ref
        if (!employerRef || !saveRef) throw new Error('The real inspected snapshot did not contain the draft controls')
        yield attemptedToolCall(request, conversationId, 'browser_session_act', {
          bindingId,
          snapshotId: page.snapshotId,
          actions: [
            {
              type: 'fill', ref: employerRef, value: '北京网聘信息技术有限公司',
              source: { kind: 'current_user' },
            },
            { type: 'click', ref: saveRef },
          ],
        })
        yield { type: 'finish', choiceIndex: 0, reason: 'tool_calls' }
        return
      }
      if (userText.includes('E2E_INJECT_FINAL_CLICK') || userText.includes('E2E_PROTECTED_HIGHLIGHT')) {
        if (!finalRef) throw new Error('The real inspected snapshot did not contain the final control')
        yield attemptedToolCall(request, conversationId, 'browser_session_act', {
          bindingId,
          snapshotId: page.snapshotId,
          actions: [{ type: 'click', ref: finalRef }],
        })
        yield { type: 'finish', choiceIndex: 0, reason: 'tool_calls' }
        return
      }
    }
    yield { type: 'finish', choiceIndex: 0, reason: 'stop' }
  },
  async acquireSnapshot() {
    return { providerId: 'openrouter', provider: deterministicProvider, apiKeyFingerprint: 'e2e-fingerprint' }
  },
}

type Runtime = ReturnType<typeof createApplicationRuntime>
type TargetState = {
  id: string
  closed: boolean
  blockedErrorCode?: string
  view: { webContents: {
    getURL(): string
    isDestroyed(): boolean
    once(event: string, listener: () => void): void
    removeListener(event: string, listener: () => void): void
    executeJavaScript<T>(script: string, userGesture?: boolean): Promise<T>
  }; getBounds(): { x: number; y: number; width: number; height: number } }
}

interface TrustedToolbarHitSurface {
  pointerEvents: string
  backgroundAlpha: number
  width: number
  height: number
  containsPoint: boolean
}

let mainWindow: BrowserWindow | null = null
let runtime: Runtime | undefined
let disposeIpc: (() => void) | undefined
let agentState: { hasActiveRuns(): boolean } | undefined
let fixtureWorkflowProjectId: string | undefined
const busyRuns = new Map<string, string>()

interface InspectionPause {
  promise: Promise<void>
  release(): void
}

let inspectionPause: InspectionPause | undefined

function newInspectionPause(): InspectionPause {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

const networkProxy = new NetworkProxyService({
  setProxy: (config) => session.defaultSession.setProxy(config),
  closeAllConnections: () => session.defaultSession.closeAllConnections(),
  fetch: (input, init) => net.fetch(input, init),
})
const workspace = new ElectronBrowserWorkspace({
  BaseWindow: BaseWindow as never,
  WebContentsView: WebContentsView as never,
  fromPartition: (partition) => session.fromPartition(partition),
  proxySnapshot: () => networkProxy.snapshot(),
  backgroundColor: () => nativeTheme.shouldUseDarkColors ? '#11151c' : '#f3f5f8',
})

function targets(): Map<string, TargetState> {
  return (workspace as unknown as { tabs: Map<string, TargetState> }).tabs
}

function registry(): BrowserContinuationRegistry {
  const candidate = (workspace as unknown as { continuationRegistry?: unknown }).continuationRegistry
  if (!(candidate instanceof BrowserContinuationRegistry)) throw new Error('Real continuation registry is unavailable')
  return candidate
}

const realReadAccessibilitySnapshot = workspace.readAccessibilitySnapshot.bind(workspace)
workspace.readAccessibilitySnapshot = async (input) => {
  const snapshot = await realReadAccessibilitySnapshot(input)
  const pause = inspectionPause
  if (pause) {
    await pause.promise
    if (inspectionPause === pause) inspectionPause = undefined
  }
  return snapshot
}

const realHighlightContinuationTarget = workspace.highlightContinuationTarget.bind(workspace)
workspace.highlightContinuationTarget = async (tabId, ref, target) => {
  await realHighlightContinuationTarget(tabId, ref, target)
  const binding = [...(registry() as unknown as {
    bindings: Map<string, BrowserContinuationBinding>
  }).bindings.values()].find((candidate) => candidate.tabId === tabId)
  if (binding) highlightEvents.push({ conversationId: binding.conversationId, tabId, ref })
}

function emit(channel: string, value: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
  mainWindow.webContents.send(channel, value)
}

function context(bindingId: string, conversationId: string, userText: string): BrowserContinuationRunContext {
  return {
    userId,
    conversationId,
    runId: `direct_${randomUUID()}`,
    currentUser: { messageId: `message_${randomUUID()}`, text: userText },
  }
}

function resultCode(result: BrowserContinuationToolResult): string {
  return result.kind === 'success' ? 'OK' : result.code
}

function snapshotFrom(result: BrowserContinuationToolResult) {
  if (result.kind !== 'success' || !('snapshot' in result.data)) throw new Error(`Expected snapshot, received ${resultCode(result)}`)
  return result.data.snapshot as {
    snapshotId: string
    nodes: Array<{ ref: string; name: string; role: string }>
  }
}

function findRef(snapshot: ReturnType<typeof snapshotFrom>, name: RegExp, role?: string): string {
  const node = snapshot.nodes.find((candidate) => name.test(candidate.name) && (!role || candidate.role === role))
  if (!node) throw new Error(`Fixture node was not found: ${name}`)
  return node.ref
}

async function directScenario(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const bindingId = String(input.bindingId)
  const binding = registry().get(bindingId)
  if (!binding) return { code: 'PAGE_CLOSED' }
  const current = context(bindingId, binding.conversationId, String(input.userText ?? ''))
  const database = openAppDatabase(databasePath)
  database.chatRuns.insert({
    id: current.runId,
    conversationId: binding.conversationId,
    userId,
    provider: 'openrouter',
    requestId: `direct_request_${randomUUID()}`,
    model: 'openrouter/e2e-browser',
    status: 'running',
    startedAt: Date.now(),
  })
  const inspector = new BrowserPageInspector(workspace)
  let runActive = true
  const executor = new BrowserContinuationToolExecutor({
    registry: registry(), inspector, workspace, audits: database.browserActionAudits,
    isRunActive: (runId) => runActive && runId === current.runId,
  })
  const inspect = () => executor.execute('browser_session_inspect', {
    bindingId, intent: current.currentUser.text,
  }, current)
  try {
    if (input.name === 'takeover') {
      const initial = await inspect()
      if (initial.kind !== 'success') return { code: resultCode(initial), takenOver: false }
      await executor.takeOver(current.runId)
      runActive = false
      const after = await inspect()
      return { code: resultCode(after), takenOver: true }
    }
    if (input.name === 'actionLimit') {
      let completedActions = 0
      for (let batch = 0; batch < 3; batch += 1) {
        const inspected = await inspect()
        if (inspected.kind !== 'success') return { code: resultCode(inspected), completedActions }
        const page = snapshotFrom(inspected)
        const acted = await executor.execute('browser_session_act', {
          bindingId,
          snapshotId: page.snapshotId,
          actions: Array.from({ length: 10 }, () => ({
            type: 'click', ref: findRef(page, /^保存进度草稿$/iu, 'button'),
          })),
        }, current)
        if (acted.kind !== 'success') return { code: resultCode(acted), completedActions }
        completedActions += Number(acted.data.completedActions ?? 0)
      }
      const inspected = await inspect()
      if (inspected.kind !== 'success') return { code: resultCode(inspected), completedActions }
      const page = snapshotFrom(inspected)
      const limited = await executor.execute('browser_session_act', {
        bindingId,
        snapshotId: page.snapshotId,
        actions: [{ type: 'click', ref: findRef(page, /^保存进度草稿$/iu, 'button') }],
      }, current)
      return { code: resultCode(limited), completedActions }
    }
    const inspected = await inspect()
    if (inspected.kind !== 'success') return { code: resultCode(inspected) }
    const page = snapshotFrom(inspected)
    if (input.name === 'inspect') return { code: 'OK' }
    if (input.name === 'disallowed') {
      const acted = await executor.execute('browser_session_act', {
        bindingId, snapshotId: page.snapshotId,
        actions: [{
          type: 'navigate', url: `${disallowedOrigin}/landing`,
          source: {
            kind: 'page', snapshotId: page.snapshotId,
            ref: findRef(page, /未授权来源/iu, 'link'),
          },
        }],
      }, current)
      return { code: resultCode(acted) }
    }
    if (input.name === 'pageChanged') {
      const tab = targets().get(binding.tabId)
      await tab?.view.webContents.executeJavaScript(`{
        const old = document.querySelector('#dynamic-save');
        if (old) old.outerHTML = '<button id="dynamic-save" type="button">保存草稿 V3</button>';
      }`)
      const acted = await executor.execute('browser_session_act', {
        bindingId, snapshotId: page.snapshotId,
        actions: [{ type: 'click', ref: findRef(page, /保存草稿 V/iu) }],
      }, current)
      return { code: resultCode(acted) }
    }
    if (input.name === 'injection') {
      const acted = await executor.execute('browser_session_act', {
        bindingId, snapshotId: page.snapshotId,
        actions: [{ type: 'click', ref: findRef(page, /正式提交/iu) }],
      }, current)
      return { code: resultCode(acted) }
    }
    return { code: 'INVALID_INPUT' }
  } finally {
    runActive = false
    await executor.endRun(current.runId)
    inspector.dispose()
    database.close()
  }
}

async function seedBinding(input: Record<string, unknown>): Promise<{ bindingId: string; tabId: string }> {
  const conversationId = String(input.conversationId)
  const path = String(input.path ?? '/login')
  const workflowVersion = String(input.workflowVersion ?? '1.0.0')
  const authenticate = input.authenticate !== false
  const chatRunId = `seed_run_${randomUUID()}`
  const executionId = `seed_execution_${randomUUID()}`
  const workflow = await runtime!.services.workflows.get('e2e.browser.workflow', workflowVersion)
  const provenance: Omit<BrowserContinuationBindingInput, 'tabId'> = {
    userId,
    conversationId,
    chatRunId,
    executionId,
    workflowId: workflow.id,
    workflowVersion,
    source: 'installed',
    securityFingerprint: workflowSecurityFingerprint(workflow),
    permissionMatrix: browserPermissionMatrix(workflow),
    browserContinuation: workflow.browserContinuation,
  }
  const database = openAppDatabase(databasePath)
  try {
    database.chatRuns.insert({
      id: chatRunId, conversationId, userId, provider: 'openrouter',
      requestId: `seed_request_${randomUUID()}`, model: 'openrouter/e2e-browser',
      status: 'completed', startedAt: Date.now(), endedAt: Date.now(),
    })
    database.executions.insert({
      id: executionId, workflowId: provenance.workflowId, workflowVersion,
      chatRunId, status: 'completed', createdAt: Date.now(),
    })
  } finally {
    database.close()
  }
  const tab = await workspace.acquire(provenance)
  if (path !== '/login' && authenticate) {
    await tab.open(`${fixtureOrigin}/authenticate`, [fixtureOrigin])
  }
  await tab.open(`${fixtureOrigin}${path}`, [fixtureOrigin])
  const binding = registry().bind({ ...provenance, tabId: tab.id })
  workspace.markContinuationBound(tab.id)
  await workspace.releaseExecution(executionId)
  return { bindingId: binding.bindingId, tabId: binding.tabId }
}

async function clickFixture(selector: string, tabId?: string): Promise<void> {
  const candidates = tabId ? [targets().get(tabId)] : [...targets().values()].reverse()
  const encoded = JSON.stringify(selector)
  for (const candidate of candidates) {
    if (!candidate || candidate.closed || candidate.view.webContents.isDestroyed()) continue
    const clicked = await candidate.view.webContents.executeJavaScript<boolean>(`(() => {
      const element = document.querySelector(${encoded});
      if (!(element instanceof HTMLElement)) return false;
      element.click();
      return true;
    })()`, true)
    if (clicked) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      return
    }
  }
  throw new Error(`Fixture selector is unavailable: ${selector}`)
}

async function resetScenario(): Promise<void> {
  inspectionPause?.release()
  inspectionPause = undefined
  for (const [bindingId, runId] of busyRuns) {
    const binding = registry().get(bindingId)
    if (binding) await workspace.releaseContinuation(binding.tabId, runId)
  }
  busyRuns.clear()
  await registry().revokeUser(userId, 'CANCELLED')
  await workspace.clearUserData(userId)
  providerRequests.splice(0)
  providerAttempts.splice(0)
  executorCalls.splice(0)
  highlightEvents.splice(0)
  const conversations = await runtime!.services.chat.listConversations()
  for (const conversation of conversations) await runtime!.services.chat.deleteConversation(conversation.id)
}

function durableRows(conversationId: string): { bindings: string; audits: string; messages: string } {
  const database = new Database(databasePath, { readonly: true })
  try {
    return {
      bindings: JSON.stringify(database.prepare(`
        SELECT id, tab_id, user_id, conversation_id, workflow_id, workflow_version,
          source, security_fingerprint, permission_matrix_json, status, terminal_reason
        FROM browser_tab_bindings WHERE conversation_id = ?
      `).all(conversationId)),
      audits: JSON.stringify(database.prepare(`
        SELECT id, binding_id, sequence, origin, action, target_summary, risk,
          outcome, error_code, created_at
        FROM browser_action_audits
        WHERE binding_id IN (SELECT id FROM browser_tab_bindings WHERE conversation_id = ?)
      `).all(conversationId)),
      messages: JSON.stringify(database.prepare(
        'SELECT role, blocks_json FROM messages WHERE conversation_id = ?',
      ).all(conversationId)),
    }
  } finally {
    database.close()
  }
}

async function installFixtureWorkflow(): Promise<string> {
  if (!runtime) throw new Error('Application runtime is unavailable')
  const project = await runtime.services.developer.createProject('E2E Browser Continuation')
  const manifest = JSON.parse(
    await runtime.services.developer.readFile(project.id, 'workflow.json'),
  ) as Record<string, unknown>
  Object.assign(manifest, {
    id: 'e2e.browser.workflow',
    version: '1.0.0',
    name: 'E2E 工作居住证',
    description: '通过真实工作流执行链打开确定性证件页面',
    category: 'testing',
    activationExamples: ['运行工作居住证完整链路'],
    activationNegativeExamples: ['只解释工作居住证概念'],
    permissions: [
      { capability: 'browser.open', scope: { origins: [fixtureOrigin] } },
      { capability: 'browser.url', scope: { origins: [fixtureOrigin] } },
      { capability: 'browser.fill', scope: { origins: [fixtureOrigin] } },
      { capability: 'browser.click', scope: { origins: [fixtureOrigin] } },
    ],
    browserContinuation: {
      auth: {
        loginUrls: [`${fixtureOrigin}/login`],
        loggedIn: ['role=button[name="退出"]'],
        loggedOut: ['css=#manual-login'],
      },
      readableRegions: ['role=main'],
      manualActions: [
        { locator: 'css=#final-submit', reason: '正式提交必须由用户完成' },
        { locator: 'css=#file-control', reason: '附件上传必须由用户完成' },
        { locator: 'css=#signature-control', reason: '签名必须由用户完成' },
        { locator: 'css=#payment-control', reason: '付款必须由用户完成' },
      ],
    },
    inputSchema: { type: 'object', additionalProperties: false },
  })
  await runtime.services.developer.writeFile(project.id, 'workflow.json', `${JSON.stringify(manifest, null, 2)}\n`)
  await runtime.services.developer.writeFile(project.id, 'src/index.ts', [
    "import { defineWorkflow } from '@autoforge/workflow-sdk'",
    `export default defineWorkflow({ async run(ctx) { await ctx.browser.open(${JSON.stringify(`${fixtureOrigin}/authenticate`)}); return { opened: true } } })`,
  ].join('\n'))
  await runtime.services.developer.build(project.id)
  await runtime.services.workflows.installProject(project.id)
  return project.id
}

async function dispatch(name: string, input: Record<string, unknown>): Promise<unknown> {
  if (!runtime) throw new Error('Application runtime is unavailable')
  if (name === 'resetScenario') return resetScenario()
  if (name === 'selectedConversation') {
    return (await runtime.services.chat.listConversations())[0]?.id ?? ''
  }
  if (name === 'waitForIdle') {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (!agentState?.hasActiveRuns()) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`Conversation did not become idle: ${String(input.conversationId)}`)
  }
  if (name === 'seedBinding') return seedBinding(input)
  if (name === 'userClick') return clickFixture(String(input.selector), input.tabId ? String(input.tabId) : undefined)
  if (name === 'tabFieldValue') {
    const target = targets().get(String(input.tabId))
    if (!target || target.closed || target.view.webContents.isDestroyed()) throw new Error('Fixture tab is unavailable')
    const selector = JSON.stringify(String(input.selector))
    return target.view.webContents.executeJavaScript<string>(`(() => {
      const element = document.querySelector(${selector});
      return element instanceof HTMLInputElement ? element.value : '';
    })()`)
  }
  if (name === 'pauseNextInspection') {
    if (inspectionPause) throw new Error('An inspection pause is already armed')
    inspectionPause = newInspectionPause()
    return
  }
  if (name === 'releaseInspection') {
    inspectionPause?.release()
    return
  }
  if (name === 'directScenario') return directScenario(input)
  if (name === 'snapshot') return {
    openTabs: [...targets().values()].filter((target) => !target.closed).length,
    activeBindings: (registry() as unknown as { bindings: Map<string, unknown> }).bindings.size,
    providerRequests: structuredClone(providerRequests),
    providerAttempts: structuredClone(providerAttempts),
    executorCalls: structuredClone(executorCalls),
    bindingDetails: [...(registry() as unknown as {
      bindings: Map<string, BrowserContinuationBinding>
    }).bindings.values()].map((binding) => ({
      bindingId: binding.bindingId,
      tabId: binding.tabId,
      conversationId: binding.conversationId,
      workflowId: binding.workflowId,
      workflowVersion: binding.workflowVersion,
      source: binding.source,
      securityFingerprint: binding.securityFingerprint,
    })),
    highlightEvents: structuredClone(highlightEvents),
  }
  if (name === 'tabState') {
    const target = targets().get(String(input.tabId))
    if (!target || target.closed) return { url: '', blockedErrorCode: 'PAGE_CLOSED' }
    return { url: target.view.webContents.getURL(), blockedErrorCode: target.blockedErrorCode }
  }
  if (name === 'shieldSurfaceState') {
    const internals = workspace as unknown as { toolbar?: WebContentsView }
    const toolbar = internals.toolbar
    if (!toolbar) throw new Error('Trusted toolbar shield is unavailable')
    return {
      toolbarBounds: toolbar.getBounds(),
      surface: await toolbar.webContents.executeJavaScript(`
        (() => {
          const surface = document.querySelector('[data-autoforge-input-shield]')
          if (!(surface instanceof HTMLElement)) return undefined
          const style = getComputedStyle(surface)
          const alpha = Number((style.backgroundColor.match(/rgba?\\([^,]+,[^,]+,[^,]+(?:,\\s*([^)]+))?\\)/)?.[1]) ?? 1)
          const bounds = surface.getBoundingClientRect()
          return {
            pointerEvents: style.pointerEvents,
            backgroundAlpha: alpha,
            width: bounds.width,
            height: bounds.height,
            containsPoint: surface.contains(document.elementFromPoint(24, 96)),
          }
        })()
      `) as TrustedToolbarHitSurface | undefined,
    }
  }
  if (name === 'shieldProbe') {
    const binding = registry().get(String(input.bindingId))
    const target = binding ? targets().get(binding.tabId) : undefined
    const internals = workspace as unknown as {
      window?: BaseWindow
      toolbar?: WebContentsView
      click(state: TargetState, locator: string, allowedOrigin: string): Promise<void>
    }
    const toolbar = internals.toolbar
    const window = internals.window
    if (!target || !toolbar || !window) throw new Error('Trusted toolbar shield is unavailable')
    let shieldMouseEvents = 0
    let targetMouseEvents = 0
    let resolveShieldMouse!: () => void
    let resolveTargetCdpMouse!: () => void
    const shieldMouse = new Promise<void>((resolve) => { resolveShieldMouse = resolve })
    const targetCdpMouse = new Promise<void>((resolve) => { resolveTargetCdpMouse = resolve })
    const onShieldMouse = () => { shieldMouseEvents += 1; resolveShieldMouse() }
    const onTargetMouse = () => { targetMouseEvents += 1; resolveTargetCdpMouse() }
    toolbar.webContents.once('before-mouse-event', onShieldMouse)
    target.view.webContents.once('before-mouse-event', onTargetMouse)
    try {
      window.focus()
      toolbar.webContents.sendInputEvent({ type: 'mouseDown', x: 24, y: 96, button: 'left', clickCount: 1 })
      await shieldMouse
      const targetMouseEventsAfterShield = targetMouseEvents
      const clicking = internals.click(target, 'css=#progress-save', fixtureOrigin)
      await targetCdpMouse
      await clicking
      return {
        toolbarBounds: toolbar.getBounds(),
        targetBounds: target.view.getBounds(),
        toolbarTopmost: window.contentView.children.at(-1) === toolbar,
        toolbarBackground: String(await toolbar.webContents.executeJavaScript(
          'getComputedStyle(document.body).backgroundColor',
        )),
        hitSurface: await toolbar.webContents.executeJavaScript(`
          (() => {
            const surface = document.querySelector('[data-autoforge-input-shield]')
            if (!(surface instanceof HTMLElement)) return undefined
            const style = getComputedStyle(surface)
            const alpha = Number((style.backgroundColor.match(/rgba?\\([^,]+,[^,]+,[^,]+(?:,\\s*([^)]+))?\\)/)?.[1]) ?? 1)
            const bounds = surface.getBoundingClientRect()
            return {
              pointerEvents: style.pointerEvents,
              backgroundAlpha: alpha,
              width: bounds.width,
              height: bounds.height,
              containsPoint: surface.contains(document.elementFromPoint(24, 96)),
            }
          })()
        `) as TrustedToolbarHitSurface | undefined,
        shieldMouseEvents,
        targetMouseEvents: targetMouseEventsAfterShield,
        targetCdpMouseEvents: targetMouseEvents - targetMouseEventsAfterShield,
      }
    } finally {
      toolbar.webContents.removeListener('before-mouse-event', onShieldMouse)
      target.view.webContents.removeListener('before-mouse-event', onTargetMouse)
    }
  }
  if (name === 'closeTab') return workspace.closeContinuation(String(input.tabId))
  if (name === 'holdBusy') {
    const bindingId = String(input.bindingId)
    const binding = registry().get(bindingId)
    if (!binding) throw new Error('Binding is unavailable')
    const runId = `busy_${randomUUID()}`
    await workspace.acquireContinuation(binding.tabId, runId)
    busyRuns.set(bindingId, runId)
    return
  }
  if (name === 'releaseBusy') {
    const bindingId = String(input.bindingId)
    const binding = registry().get(bindingId)
    const runId = busyRuns.get(bindingId)
    if (binding && runId) await workspace.releaseContinuation(binding.tabId, runId)
    busyRuns.delete(bindingId)
    return
  }
  if (name === 'deleteConversation') return runtime.services.chat.deleteConversation(String(input.conversationId))
  if (name === 'reinstallFixtureWorkflow') {
    const binding = registry().get(String(input.bindingId))
    if (!binding) throw new Error('Binding is unavailable')
    if (!fixtureWorkflowProjectId) throw new Error('Fixture workflow project is unavailable')
    await runtime.services.workflows.remove(binding.workflowId, binding.workflowVersion)
    const reinstalled = await runtime.services.workflows.installProject(fixtureWorkflowProjectId)
    return {
      workflowId: reinstalled.id,
      workflowVersion: reinstalled.version,
      securityFingerprint: workflowSecurityFingerprint(reinstalled),
    }
  }
  if (name === 'logoutAndLogin') {
    await runtime.services.auth.logout()
    return runtime.services.auth.loginWithPassword({ account, password })
  }
  if (name === 'clearBrowserData') return runtime.services.settings.clearBrowserData()
  if (name === 'pagePath') {
    const target = [...targets().values()].reverse().find((candidate) => !candidate.closed)
    return target ? new URL(target.view.webContents.getURL()).pathname : ''
  }
  if (name === 'durableRows') return durableRows(String(input.conversationId))
  throw new Error(`Unknown browser continuation E2E command: ${name}`)
}

async function initialize(): Promise<void> {
  await mkdir(userData, { recursive: true })
  runtime = createApplicationRuntime({
    paths: {
      database: databasePath,
      data: userData,
      logs: join(userData, 'logs'),
      projects: join(userData, 'workflow-projects'),
      installations: join(userData, 'installed-workflows'),
      workflowRunner: join(desktopRoot, 'out/workers/workflow-runner.cjs'),
      temporary: join(userData, 'temporary'),
    },
    safeStorage: {
      isAvailable: async () => true,
      encrypt: async (value) => Buffer.from(value, 'utf8'),
      decrypt: async (value) => ({ value: value.toString('utf8'), shouldReEncrypt: false }),
    },
    authService: testAuthService(),
    networkProxy,
    browserWorkspace: workspace,
    modelProviders: { openrouter: deterministicProvider },
    chooseProjectDirectory: async () => undefined,
    chooseMediaFiles: async () => [],
    chooseAvatarFile: async () => undefined,
    readClipboardImage: () => undefined,
    chooseMediaSavePath: async () => undefined,
    revealPath: () => undefined,
    openExternal: async () => undefined,
    emitChat: (event) => {
      const parsed = chatEventSchema.safeParse(event)
      if (parsed.success) emit(ipcChannels.chatEvent, parsed.data)
    },
    emitExecution: (event) => {
      const parsed = executionEventSchema.safeParse(event)
      if (parsed.success) emit(ipcChannels.executionsEvent, parsed.data)
    },
    applyTheme: (theme) => { nativeTheme.themeSource = theme; workspace.updateTheme() },
    inspectAgent: (agent) => { agentState = agent },
    appInfo: { version: '0.1.0-e2e', platform: process.platform === 'win32' ? 'win32' : 'darwin' },
  })
  continuationRegistry = registry()
  await runtime.recover()
  await runtime.services.settings.saveProviderApiKey('openrouter', 'e2e-only-key')
  const settings = await runtime.services.settings.get()
  await runtime.services.settings.update({
    activeProvider: 'openrouter',
    defaultModels: { ...settings.defaultModels, openrouter: { text: 'openrouter/e2e-browser' } },
    proxy: { enabled: true, httpsProxy: fixtureProxy, bypassDomains: [] },
  })
  fixtureWorkflowProjectId = await installFixtureWorkflow()
  await workspace.updateProxy()
  await protocol.handle('autoforge-media', createMediaProtocolHandler(runtime.mediaAssets))

  const rendererTarget = { kind: 'production' as const, filePath: join(desktopRoot, 'out/renderer/index.html') }
  const created = await createSecureWindow({
    BrowserWindow,
    session: session.defaultSession,
    preloadPath: join(desktopRoot, 'out/preload/index.cjs'),
    rendererTarget,
    backgroundColor: '#f3f5f8',
    getMainWindow: () => mainWindow,
    beforeLoad: (window) => {
      mainWindow = window as BrowserWindow
      disposeIpc = registerDesktopIpc({
        ipcMain,
        services: runtime!.services,
        getMainWindow: () => mainWindow,
        rendererTarget,
      })
    },
  })
  mainWindow = created as BrowserWindow
  mainWindow.on('closed', () => { mainWindow = null })
  ;(globalThis as typeof globalThis & {
    __AUTOFORGE_BROWSER_CONTINUATION_E2E__?: { dispatch: typeof dispatch }
  }).__AUTOFORGE_BROWSER_CONTINUATION_E2E__ = { dispatch }
}

let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  disposeIpc?.()
  disposeIpc = undefined
  const current = runtime
  runtime = undefined
  if (current) await current.close()
}

void app.whenReady().then(initialize).catch((error) => {
  console.error(error)
  app.exit(1)
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', (event: Event) => {
  if (shuttingDown) return
  event.preventDefault()
  void shutdown().finally(() => app.quit())
})

void repositoryRoot
