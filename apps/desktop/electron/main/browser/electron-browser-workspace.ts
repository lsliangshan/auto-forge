import { createHash, randomUUID } from 'node:crypto'
import {
  matchesHttpsUrlPattern,
  parseBrowserLocator,
  toSafeAppError,
  type AppError,
  type AppErrorCode,
} from '@autoforge/shared'
import type { NetworkProxySnapshot } from '../network/network-proxy-service.js'
import { canonicalJson } from '../workflows/workflow-security-fingerprint.js'
import {
  frozenBrowserContinuationProvenance,
  type BrowserAction,
  type BrowserContinuationPageState,
  type BrowserContinuationProvenance,
  type BrowserContinuationResolvedTargetInput,
} from './browser-continuation-types.js'
import {
  MAX_BROWSER_INSPECTION_LOCATOR_MATCHES,
  MAX_BROWSER_INSPECTION_RAW_BYTES,
  MAX_BROWSER_INSPECTION_RAW_NODES,
  type BrowserInspectionDomSummary,
  type BrowserInspectionNode,
  type BrowserInspectionNodeBox,
  type BrowserPageCdpPort,
  type BrowserPageReadResult,
} from './browser-page-inspector.js'

interface InspectionCommandBudget {
  readonly signal?: AbortSignal
  readonly deadlineAt: number
  calls: number
  bytes: number
}

const maxBrowserInspectionCdpCalls = 2_048
const maxBrowserInspectionDurationMs = 5_000
const maxBrowserInspectionTotalLocatorMatches = 2_048

interface Rectangle { x: number; y: number; width: number; height: number }
interface NavigationEvent { preventDefault(): void }

interface DebuggerPort {
  isAttached(): boolean
  attach(protocolVersion?: string): void
  detach(): void
  sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>
}

interface NavigationHistoryPort {
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
}

type WebContentsListener = (...args: never[]) => void

interface WebContentsPort {
  readonly id: number
  readonly debugger: DebuggerPort
  readonly navigationHistory: NavigationHistoryPort
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  isDestroyed(): boolean
  close(): void
  reload(): void
  on(event: string, listener: WebContentsListener): this
  once(event: string, listener: WebContentsListener): this
  removeListener(event: string, listener: WebContentsListener): this
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void
}

interface WebContentsViewPort {
  readonly webContents: WebContentsPort
  setBounds(bounds: Rectangle): void
}

interface ContentViewPort {
  addChildView(view: WebContentsViewPort): void
  removeChildView(view: WebContentsViewPort): void
}

interface BaseWindowPort {
  readonly contentView: ContentViewPort
  getContentBounds(): Rectangle
  isDestroyed(): boolean
  show(): void
  focus(): void
  setBackgroundColor(color: string): void
  close(): void
  on(event: 'resize' | 'closed', listener: () => void): this
}

interface SessionPort {
  setProxy(config: { mode: 'direct' | 'fixed_servers'; proxyRules?: string; proxyBypassRules?: string }): Promise<void>
  closeAllConnections(): Promise<void>
  clearStorageData(): Promise<void>
  clearCache(): Promise<void>
  setPermissionRequestHandler(handler: (
    webContents: unknown,
    permission: string,
    callback: (allowed: boolean) => void,
    details: unknown,
  ) => void): void
  setPermissionCheckHandler?(handler: () => boolean): void
  on?(event: 'will-download', listener: (event: NavigationEvent) => void): this
}

type BaseWindowConstructor = new (options: Record<string, unknown>) => BaseWindowPort
type WebContentsViewConstructor = new (options?: Record<string, unknown>) => WebContentsViewPort

export type BrowserWorkspaceAcquireInput = Pick<
  BrowserContinuationProvenance,
  'executionId' | 'userId' | 'workflowId'
> & Partial<Omit<
  BrowserContinuationProvenance,
  'executionId' | 'userId' | 'workflowId'
>>

export interface BrowserWorkspaceTab {
  readonly id: string
  readonly navigationEpoch: number
  open(url: string, allowedOrigins: readonly string[]): Promise<void>
  fill(locator: string, value: string, allowedOrigin: string): Promise<void>
  click(locator: string, allowedOrigin: string): Promise<void>
  url(): Promise<string>
  currentOrigin(): Promise<string>
  focus(): Promise<void>
  close(): Promise<void>
}

export interface BrowserWorkspaceContinuationRegistryPort {
  bindPopup(parentTabId: string, tabId: string): unknown
  list(userId: string, conversationId: string): readonly {
    bindingId: string
    tabId: string
  }[]
  currentLease(bindingId: string): {
    binding: { bindingId: string; tabId: string }
    runId: string
  } | undefined
  markClosed(tabId: string, reason: AppErrorCode): void
  markTakenOver(tabId: string, runId: string): Promise<void> | void
}

export interface BrowserContinuationCommandHandlers {
  stop(bindingId: string): Promise<void>
  takeOver(bindingId: string): Promise<void>
}

export interface BrowserContinuationDescription {
  readonly pageLabel: string
  readonly origin: string
  readonly lastActiveAt: number
}

export interface BrowserWorkspacePort {
  acquire(input: BrowserWorkspaceAcquireInput): Promise<BrowserWorkspaceTab>
  releaseExecution(executionId: string): Promise<void> | void
  markContinuationBound?(tabId: string): void
  setContinuationRegistry?(registry: BrowserWorkspaceContinuationRegistryPort): void
  updateProxy(): Promise<void>
  reset(): Promise<void>
  shutdown(): Promise<void>
}

export interface ApplicationBrowserWorkspacePort extends BrowserWorkspacePort, BrowserPageCdpPort {
  acquireContinuation(tabId: string, runId: string): Promise<void>
  releaseContinuation(tabId: string, runId: string): Promise<void>
  closeContinuation(tabId: string): Promise<void>
  getContinuationState(tabId: string, runId: string): Promise<BrowserContinuationPageState>
  focusContinuation(tabId: string, runId: string): Promise<void>
  highlightContinuationTarget(
    tabId: string,
    ref: string,
    target: BrowserContinuationResolvedTargetInput,
  ): Promise<void>
  clearContinuationHighlight(tabId: string): Promise<void>
  performContinuationAction(input: BrowserContinuationResolvedTargetInput & {
    readonly tabId: string
    readonly action: BrowserAction
  }): Promise<void>
  describeContinuation(tabId: string): Promise<BrowserContinuationDescription | undefined>
  clearUserData(userId: string): Promise<void>
  setContinuationCommandHandlers(handlers: BrowserContinuationCommandHandlers): void
}

export interface ElectronBrowserWorkspaceOptions {
  BaseWindow: BaseWindowConstructor
  WebContentsView: WebContentsViewConstructor
  fromPartition(partition: string): SessionPort
  proxySnapshot(): Promise<NetworkProxySnapshot>
  backgroundColor(): string
}

interface TargetTabState {
  id: string
  userId: string
  workflowId: string
  partition: string
  view: WebContentsViewPort
  ownerExecutionId?: string
  ownerContinuationRunId?: string
  continuation?: BrowserContinuationProvenance
  reuseIdentity?: string
  continuationBound: boolean
  popupPatterns?: readonly string[]
  navigationEpoch: number
  automationOrigins?: readonly string[]
  allowedOrigins?: readonly string[]
  navigationViolation?: AppError
  blockedOrigin?: string
  blockedErrorCode?: AppErrorCode
  activeOperations: number
  syntheticInputOperations: number
  loading: boolean
  lastActiveAt: number
  closed: boolean
  handle?: BrowserWorkspaceTab
}

interface AccessibilityValue {
  value?: unknown
}

interface AccessibilityNodeResult {
  nodeId?: string
  parentId?: string
  backendDOMNodeId?: number
  frameId?: string
  ignored?: boolean
  role?: AccessibilityValue
  name?: AccessibilityValue
  value?: AccessibilityValue
  properties?: Array<{ name?: string; value?: AccessibilityValue }>
}

interface DescribedDomNode {
  backendNodeId?: number
  nodeName?: string
  attributes?: string[]
}

const toolbarHeight = 52
const navigationDetectionMs = 500
const postLoadNavigationDetectionMs = 1_000
function failure(code: AppErrorCode): AppError {
  return toSafeAppError({ code })
}

function continuationFromAcquire(
  input: BrowserWorkspaceAcquireInput,
): BrowserContinuationProvenance | undefined {
  if (input.conversationId === undefined || input.chatRunId === undefined
    || input.workflowVersion === undefined || input.source === undefined
    || input.securityFingerprint === undefined || input.permissionMatrix === undefined) return undefined
  return frozenBrowserContinuationProvenance({
    userId: input.userId,
    conversationId: input.conversationId,
    chatRunId: input.chatRunId,
    executionId: input.executionId,
    workflowId: input.workflowId,
    workflowVersion: input.workflowVersion,
    source: input.source,
    ...(input.buildHash === undefined ? {} : { buildHash: input.buildHash }),
    securityFingerprint: input.securityFingerprint,
    permissionMatrix: input.permissionMatrix,
    ...(input.browserContinuation === undefined ? {} : { browserContinuation: input.browserContinuation }),
  })
}

function continuationReuseIdentity(provenance: BrowserContinuationProvenance): string {
  return canonicalJson({
    userId: provenance.userId,
    conversationId: provenance.conversationId,
    workflowId: provenance.workflowId,
    workflowVersion: provenance.workflowVersion,
    source: provenance.source,
    buildHash: provenance.buildHash,
    securityFingerprint: provenance.securityFingerprint,
    permissionMatrix: provenance.permissionMatrix,
    browserContinuation: provenance.browserContinuation,
  })
}

function originOf(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') throw failure('INVALID_INPUT')
    return url.origin
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) throw error
    throw failure('INVALID_INPUT')
  }
}

function isAbortedNavigation(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ERR_ABORTED'
}

function normalizedAccessibilityRole(value: string): string {
  const role = value.replaceAll(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
  if (role === 'static-text' || role === 'inline-text-box') return 'statictext'
  return role
}

function parseLocator(locator: string) {
  const parsed = parseBrowserLocator(locator)
  if (!parsed) throw failure('INVALID_INPUT')
  return parsed
}

function html(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function loadingHost(value: string): string {
  try { return new URL(value).hostname || '目标站点' }
  catch { return '目标站点' }
}

function toolbarDocument(
  tabs: readonly TargetTabState[],
  activeId: string | undefined,
  automationBindingId: string | undefined,
): string {
  const active = tabs.find((tab) => tab.id === activeId)
  const tabMarkup = tabs.map((tab) => {
    const title = tab.view.webContents.getTitle() || tab.workflowId
    return `<span class="tab${tab.id === activeId ? ' active' : ''}"><a href="autoforge-browser://activate/${tab.id}">${html(title)}</a><a class="close" href="autoforge-browser://close/${tab.id}">×</a></span>`
  }).join('')
  const address = active && !active.view.webContents.isDestroyed() ? active.view.webContents.getURL() : ''
  const host = loadingHost(address)
  const blockedOrigin = active?.blockedOrigin
  const blocked = blockedOrigin
    ? `<main class="blocked" role="alert"><div class="blocked-card"><span class="blocked-kicker">SECURITY BLOCK · ${active?.blockedErrorCode ?? 'CAPABILITY_SCOPE_DENIED'}</span><strong>已阻止未授权跳转</strong><p>工作流尝试访问未在精确权限范围内的网站：</p><code>${html(blockedOrigin)}</code><small>请在工作流权限中添加该精确域名并重新构建后重试。</small></div></main>`
    : ''
  const loading = !blockedOrigin && active?.loading === true
    ? `<main class="loading" role="status" aria-live="polite"><div class="loading-shell"><div class="connection-orbit" aria-hidden="true"><span class="orbit orbit-outer"></span><span class="orbit orbit-inner"></span><span class="orbit-core"></span></div><div class="loading-copy"><span class="loading-kicker">SECURE SESSION</span><strong>正在连接 <span>${html(host)}</span></strong><small>正在建立受保护的网页会话，请稍候</small><div class="progress-track" aria-hidden="true"><span></span></div><div class="connection-stages" aria-hidden="true"><span class="complete">请求站点</span><i></i><span class="current">建立连接</span><i></i><span>等待响应</span></div></div></div></main>`
    : ''
  const automation = automationBindingId === undefined
    ? ''
    : `<div class="automation-controls"><span class="automation" aria-live="polite">AI 正在操作</span><a href="autoforge-browser://continuation/stop/${html(automationBindingId)}">停止</a><a href="autoforge-browser://continuation/takeover/${html(automationBindingId)}">接管</a></div>`
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
  :root{color-scheme:light dark;--canvas:#f3f5f8;--surface:#fff;--surface-muted:#f8f9fb;--border:#dfe3e8;--border-strong:#c8ced6;--text:#303640;--muted:#68717d;--accent:#2563eb;--accent-soft:#eaf1ff;--loading-glow:rgb(37 99 235 / 14%);--loading-grid:rgb(104 113 125 / 8%);--loading-track:#d8e0eb}@media(prefers-color-scheme:dark){:root{--canvas:#11151c;--surface:#181d26;--surface-muted:#202630;--border:#343d4c;--border-strong:#4a5565;--text:#dbe4ef;--muted:#aeb8c6;--accent:#6f9cff;--accent-soft:#26354f;--loading-glow:rgb(111 156 255 / 16%);--loading-grid:rgb(174 184 198 / 7%);--loading-track:#303a48}}
  *{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--text);font:12px -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;overflow:hidden}.bar{height:52px;display:grid;grid-template-rows:26px 26px;border-bottom:1px solid var(--border);background:var(--surface)}.tabs{display:flex;gap:3px;align-items:end;padding:3px 6px 0;overflow:hidden}.tab{display:flex;min-width:80px;max-width:190px;background:var(--surface-muted);border-radius:5px 5px 0 0}.tab.active{background:var(--accent-soft)}.tab a{color:inherit;text-decoration:none;padding:4px 7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tab a:first-child{flex:1}.tab .close{flex:none}.nav{display:flex;align-items:center;gap:4px;padding:2px 6px;background:var(--surface-muted)}.nav a{color:var(--text);text-decoration:none;padding:2px 7px;border-radius:4px;background:var(--surface);border:1px solid var(--border)}.address{flex:1;min-width:0;padding:3px 8px;border-radius:4px;background:var(--canvas);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.automation-controls{display:flex;align-items:center;gap:4px}.automation{padding:2px 6px;border-radius:999px;background:var(--accent-soft);color:var(--accent);font-weight:650;white-space:nowrap}
  .loading{position:relative;isolation:isolate;height:calc(100vh - 52px);display:grid;place-items:center;overflow:hidden;background:var(--canvas)}.loading:before{position:absolute;z-index:-1;inset:0;background:radial-gradient(circle at 42% 46%,var(--loading-glow),transparent 31%),linear-gradient(var(--loading-grid) 1px,transparent 1px),linear-gradient(90deg,var(--loading-grid) 1px,transparent 1px);background-size:auto,42px 42px,42px 42px;content:"";mask-image:linear-gradient(to bottom,transparent 5%,#000 32%,#000 68%,transparent 95%)}.loading-shell{display:grid;width:min(520px,calc(100vw - 56px));grid-template-columns:92px minmax(0,1fr);align-items:center;gap:26px;transform:translateY(-5vh)}.connection-orbit{position:relative;width:76px;height:76px}.orbit{position:absolute;border:1px solid var(--border-strong);border-radius:50%}.orbit-outer{inset:0;border-top-color:var(--accent);border-right-color:transparent;animation:orbit-spin 2.6s linear infinite}.orbit-outer:after{position:absolute;top:4px;right:10px;width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 5px var(--accent-soft);content:""}.orbit-inner{inset:12px;border-bottom-color:var(--accent);border-left-color:transparent;animation:orbit-spin 1.9s linear infinite reverse}.orbit-core{inset:29px;border:0;background:var(--accent);box-shadow:0 0 0 7px var(--accent-soft);animation:core-pulse 1.8s ease-in-out infinite}.loading-copy{display:grid;min-width:0;gap:7px}.loading-kicker{color:var(--accent);font:700 9px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em}.loading strong{overflow:hidden;color:var(--text);font-size:18px;font-weight:680;line-height:1.3;text-overflow:ellipsis;white-space:nowrap}.loading strong span{color:var(--accent)}.loading small{color:var(--muted);font-size:11.5px}.progress-track{position:relative;height:3px;margin-top:9px;overflow:hidden;border-radius:2px;background:var(--loading-track)}.progress-track>span{position:absolute;top:0;bottom:0;left:-38%;width:38%;border-radius:inherit;background:var(--accent);box-shadow:0 0 10px var(--accent);animation:progress-travel 1.45s ease-in-out infinite}.connection-stages{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:9.5px;letter-spacing:.02em}.connection-stages span{flex:none}.connection-stages .complete{color:var(--text)}.connection-stages .current{color:var(--accent);font-weight:650}.connection-stages i{height:1px;min-width:18px;flex:1;background:var(--border);transform:translateY(1px)}@keyframes orbit-spin{to{transform:rotate(360deg)}}@keyframes core-pulse{50%{opacity:.55;transform:scale(.78)}}@keyframes progress-travel{50%,100%{left:100%}}@media(max-width:520px){.loading-shell{width:calc(100vw - 36px);grid-template-columns:72px 1fr;gap:18px}.connection-orbit{width:64px;height:64px}.orbit-inner{inset:10px}.orbit-core{inset:25px}.loading strong{font-size:16px}}@media(prefers-reduced-motion:reduce){.orbit,.orbit-core,.progress-track>span{animation:none}.progress-track>span{left:0;width:42%;box-shadow:none}}
  .blocked{height:calc(100vh - 52px);display:grid;place-items:center;padding:28px;background:var(--canvas)}.blocked-card{display:grid;width:min(560px,100%);gap:10px;padding:28px;border:1px solid var(--border);border-left:4px solid #dc2626;border-radius:8px;background:var(--surface);box-shadow:0 18px 44px rgb(0 0 0 / 9%)}.blocked-kicker{color:#dc2626;font:700 10px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.16em}.blocked strong{font-size:20px}.blocked p,.blocked small{margin:0;color:var(--muted);line-height:1.6}.blocked code{overflow-wrap:anywhere;padding:10px 12px;border-radius:5px;background:var(--surface-muted);color:var(--text);font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
  </style></head><body><div class="bar"><div class="tabs">${tabMarkup}</div><div class="nav"><a href="autoforge-browser://back">←</a><a href="autoforge-browser://forward">→</a><a href="autoforge-browser://reload">↻</a><div class="address">${html(address)}</div>${automation}</div></div>${blocked || loading}</body></html>`
}

function parseContinuationToolbarCommand(value: string): {
  action: 'stop' | 'takeover'
  bindingId: string
} | undefined {
  const match = /^autoforge-browser:\/\/continuation\/(stop|takeover)\/([A-Za-z0-9_-]+)$/u.exec(value)
  if (!match) return undefined
  return { action: match[1] as 'stop' | 'takeover', bindingId: match[2]! }
}

export function browserPartition(userId: string): string {
  const digest = createHash('sha256').update(userId).digest('hex').slice(0, 32)
  return `persist:autoforge-browser-${digest}`
}

class ElectronBrowserTab implements BrowserWorkspaceTab {
  constructor(
    private readonly workspace: ElectronBrowserWorkspace,
    readonly state: TargetTabState,
  ) {}

  get id(): string { return this.state.id }
  get navigationEpoch(): number { return this.state.navigationEpoch }

  open(url: string, allowedOrigins: readonly string[]): Promise<void> {
    return this.workspace.navigate(this.state, url, allowedOrigins)
  }

  fill(locator: string, value: string, allowedOrigin: string): Promise<void> {
    return this.workspace.fill(this.state, locator, value, allowedOrigin)
  }

  click(locator: string, allowedOrigin: string): Promise<void> {
    return this.workspace.click(this.state, locator, allowedOrigin)
  }

  async url(): Promise<string> {
    return this.workspace.currentUrl(this.state)
  }

  async currentOrigin(): Promise<string> {
    return this.workspace.currentOrigin(this.state)
  }

  focus(): Promise<void> {
    return this.workspace.focusTab(this.state)
  }

  close(): Promise<void> {
    return this.workspace.closeTab(this.state)
  }
}

export class ElectronBrowserWorkspace implements BrowserWorkspacePort, BrowserPageCdpPort {
  private window: BaseWindowPort | undefined
  private toolbar: WebContentsViewPort | undefined
  private activeTabId: string | undefined
  private readonly tabs = new Map<string, TargetTabState>()
  private readonly executions = new Map<string, Set<TargetTabState>>()
  private readonly sessions = new Map<string, SessionPort>()
  private readonly sessionSetups = new Map<string, Promise<SessionPort>>()
  private readonly acquisitions = new Set<Promise<BrowserWorkspaceTab>>()
  private windowCreation: Promise<void> | undefined
  private resetOperation: Promise<void> | undefined
  private lifecycleEpoch = 0
  private shuttingDown = false
  private closingViews = false
  private continuationRegistry: BrowserWorkspaceContinuationRegistryPort | undefined
  private continuationCommandHandlers: BrowserContinuationCommandHandlers | undefined
  private readonly pageInvalidationListeners = new Set<(tabId: string) => void>()
  private readonly highlightedContinuationTabs = new Set<string>()

  constructor(private readonly options: ElectronBrowserWorkspaceOptions) {}

  async acquire(input: BrowserWorkspaceAcquireInput): Promise<BrowserWorkspaceTab> {
    if (this.resetOperation) {
      await this.resetOperation
      throw failure('CANCELLED')
    }
    if (this.shuttingDown) throw failure('CONFLICT')
    const acquisition = this.acquireCurrent(input)
    this.acquisitions.add(acquisition)
    try {
      return await acquisition
    } finally {
      this.acquisitions.delete(acquisition)
    }
  }

  private async acquireCurrent(input: BrowserWorkspaceAcquireInput): Promise<BrowserWorkspaceTab> {
    if (this.shuttingDown) throw failure('CONFLICT')
    const epoch = this.lifecycleEpoch
    const continuation = continuationFromAcquire(input)
    const reuseIdentity = continuation && continuationReuseIdentity(continuation)
    const existing = reuseIdentity === undefined
      ? undefined
      : [...this.tabs.values()].find((tab) => !tab.closed
        && !tab.ownerExecutionId
        && !tab.ownerContinuationRunId
        && tab.activeOperations === 0
        && tab.reuseIdentity === reuseIdentity)
    let state: TargetTabState
    try {
      state = existing ?? await this.createTab(input)
    } catch (error) {
      if (epoch !== this.lifecycleEpoch) throw failure('CANCELLED')
      throw error
    }
    if (epoch !== this.lifecycleEpoch) throw failure('CANCELLED')
    state.ownerExecutionId = input.executionId
    state.continuation = continuation
    state.reuseIdentity = reuseIdentity
    this.addExecutionTab(input.executionId, state)
    try {
      await this.activate(state)
    } catch (error) {
      if (epoch !== this.lifecycleEpoch) throw failure('CANCELLED')
      throw error
    }
    if (epoch !== this.lifecycleEpoch) throw failure('CANCELLED')
    state.handle ??= new ElectronBrowserTab(this, state)
    return state.handle
  }

  async releaseExecution(executionId: string): Promise<void> {
    const states = this.executions.get(executionId)
    if (!states) return
    this.executions.delete(executionId)
    for (const state of states) {
      if (state.ownerExecutionId === executionId) state.ownerExecutionId = undefined
      if (state.activeOperations === 0) {
        state.automationOrigins = undefined
        state.allowedOrigins = undefined
        state.navigationViolation = undefined
      }
    }
    await this.renderToolbar().catch(() => undefined)
  }

  setContinuationRegistry(registry: BrowserWorkspaceContinuationRegistryPort): void {
    this.continuationRegistry = registry
  }

  setContinuationCommandHandlers(handlers: BrowserContinuationCommandHandlers): void {
    this.continuationCommandHandlers = handlers
  }

  markContinuationBound(tabId: string): void {
    const state = this.tabs.get(tabId)
    if (state && state.continuation) state.continuationBound = true
  }

  async acquireContinuation(tabId: string, runId: string): Promise<void> {
    const state = this.tabs.get(tabId)
    if (!state || state.closed || state.view.webContents.isDestroyed()) throw failure('PAGE_CLOSED')
    if (state.ownerExecutionId || state.ownerContinuationRunId || state.activeOperations > 0) {
      throw failure('PAGE_BUSY')
    }
    await this.clearContinuationHighlight(tabId)
    state.ownerContinuationRunId = runId
    void this.renderToolbar().catch(() => undefined)
  }

  async releaseContinuation(tabId: string, runId: string): Promise<void> {
    const state = this.tabs.get(tabId)
    if (state?.ownerContinuationRunId !== runId) return
    state.ownerContinuationRunId = undefined
    void this.renderToolbar().catch(() => undefined)
  }

  onPageInvalidated(listener: (tabId: string) => void): () => void {
    this.pageInvalidationListeners.add(listener)
    return () => { this.pageInvalidationListeners.delete(listener) }
  }

  async getContinuationState(tabId: string, runId: string): Promise<BrowserContinuationPageState> {
    const state = this.continuationState({ tabId, runId })
    return Object.freeze({
      origin: originOf(state.view.webContents.getURL()),
      url: state.view.webContents.getURL(),
      navigationEpoch: state.navigationEpoch,
    })
  }

  async describeContinuation(tabId: string): Promise<BrowserContinuationDescription | undefined> {
    const state = this.tabs.get(tabId)
    if (!state || state.closed || !state.continuationBound || state.view.webContents.isDestroyed()) return undefined
    try {
      const url = new URL(state.view.webContents.getURL())
      if (url.protocol !== 'https:' || url.username || url.password) return undefined
      return Object.freeze({
        pageLabel: url.hostname,
        origin: url.origin,
        lastActiveAt: state.lastActiveAt,
      })
    } catch {
      return undefined
    }
  }

  async focusContinuation(tabId: string, runId: string): Promise<void> {
    const state = this.continuationState({ tabId, runId })
    await this.activate(state, runId)
  }

  async highlightContinuationTarget(
    tabId: string,
    ref: string,
    target: BrowserContinuationResolvedTargetInput,
  ): Promise<void> {
    if (!ref || ref.length > 128) throw failure('INVALID_INPUT')
    const state = this.continuationState({ tabId, runId: target.runId })
    let highlightSent = false
    try {
      await this.restricted(state, [target.expectedOrigin], async () => {
        this.assertContinuationState(state, target)
        await this.assertContinuationTarget(state, target)
        await this.command(state, 'Overlay.enable')
        this.assertContinuationState(state, target)
        await this.command(state, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: target.backendNodeId })
        this.assertContinuationState(state, target)
        await this.command(state, 'Overlay.highlightNode', {
          backendNodeId: target.backendNodeId,
          highlightConfig: {
            showInfo: true,
            contentColor: { r: 37, g: 99, b: 235, a: 0.18 },
            borderColor: { r: 37, g: 99, b: 235, a: 0.95 },
          },
        })
        highlightSent = true
        this.assertContinuationState(state, target)
        this.highlightedContinuationTabs.add(tabId)
      })
    } catch (error) {
      if (highlightSent) await this.command(state, 'Overlay.hideHighlight').catch(() => undefined)
      this.highlightedContinuationTabs.delete(tabId)
      throw error
    }
  }

  async clearContinuationHighlight(tabId: string): Promise<void> {
    if (!this.highlightedContinuationTabs.has(tabId)) return
    this.highlightedContinuationTabs.delete(tabId)
    const state = this.tabs.get(tabId)
    if (!state || state.closed || state.view.webContents.isDestroyed()) return
    await this.command(state, 'Overlay.hideHighlight').catch(() => undefined)
  }

  async performContinuationAction(
    input: BrowserContinuationResolvedTargetInput & { readonly tabId: string; readonly action: BrowserAction },
  ): Promise<void> {
    const state = this.continuationState(input)
    this.assertContinuationState(state, input)
    const action = input.action
    if (action.type === 'focus') {
      await this.activate(state)
      this.assertContinuationState(state, input)
      return
    }
    if (action.type === 'navigate') {
      await this.navigate(state, action.url, [originOf(action.url)])
      return
    }
    await this.restricted(state, [input.expectedOrigin], async () => {
      this.assertContinuationState(state, input)
      const initialTarget = await this.assertContinuationTarget(state, input)
      if (action.type === 'wait') {
        await new Promise<void>((resolve) => { setTimeout(resolve, action.milliseconds) })
      } else if (action.type === 'scroll') {
        if (action.ref) {
          await this.command(state, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: input.backendNodeId })
        } else {
          await this.syntheticInput(state, () => this.command(state, 'Input.dispatchMouseEvent', {
            type: 'mouseWheel', x: 0, y: 0, deltaX: 0,
            deltaY: action.direction === 'down' ? 560 : -560,
          }))
        }
      } else if (action.type === 'fill' || action.type === 'select') {
        await this.setContinuationValue(state, input.backendNodeId, action.type, action.value)
      } else if (action.type === 'check') {
        if (initialTarget?.checked !== action.checked) {
          await this.clickContinuationNode(state, input.backendNodeId)
        }
        const checked = await this.assertContinuationTarget(state, input)
        if (checked?.checked !== action.checked) throw failure('PAGE_CHANGED')
      } else if (action.type === 'click') {
        await this.clickContinuationNode(state, input.backendNodeId)
      }
      if (action.type === 'fill' || action.type === 'select') {
        await this.assertContinuationTarget(state, input)
      }
      this.assertContinuationState(state, input)
    })
    await this.renderToolbar().catch(() => undefined)
  }

  async readAccessibilitySnapshot(
    input: Parameters<BrowserPageCdpPort['readAccessibilitySnapshot']>[0],
  ): Promise<BrowserPageReadResult> {
    const state = this.continuationState(input)
    const budget: InspectionCommandBudget = {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      deadlineAt: Math.min(
        input.deadlineAt ?? Date.now() + maxBrowserInspectionDurationMs,
        Date.now() + maxBrowserInspectionDurationMs,
      ),
      calls: 0,
      bytes: 0,
    }
    const result = await this.restricted(state, [input.expectedOrigin], async () => {
      this.assertContinuationState(state, input)
      const frameTree = await this.inspectionCommand(state, budget, 'Page.getFrameTree') as {
        frameTree?: { frame?: { id?: string } }
      }
      this.assertContinuationState(state, input)
      const frameId = frameTree.frameTree?.frame?.id
      if (!frameId) throw failure('PAGE_CHANGED')
      const accessibility = await this.inspectionCommand(state, budget, 'Accessibility.getFullAXTree') as {
        nodes?: AccessibilityNodeResult[]
      }
      this.assertContinuationState(state, input)
      const allRawNodes = accessibility.nodes ?? []
      if (allRawNodes.length > MAX_BROWSER_INSPECTION_RAW_NODES) throw failure('ACTION_LIMIT_EXCEEDED')
      const rawNodes = allRawNodes
        .filter((node) => node.frameId === undefined || node.frameId === frameId)
        .filter((node) => typeof node.nodeId === 'string' && typeof node.backendDOMNodeId === 'number')
      const nodes: BrowserInspectionNode[] = []
      for (const rawNode of rawNodes) {
        const backendNodeId = rawNode.backendDOMNodeId!
        const describedResult = await this.inspectionCommand(state, budget, 'DOM.describeNode', {
          backendNodeId, depth: 0, pierce: false,
        }) as { node?: DescribedDomNode }
        this.assertContinuationState(state, input)
        const described = describedResult.node
        if (!described) throw failure('PAGE_CHANGED')
        nodes.push(this.inspectionNode(rawNode, described))
      }
      const locatorMatches = []
      let locatorMatchCount = 0
      for (const locator of input.locators) {
        const backendNodeIds = await this.resolveLocatorMatches(state, locator, rawNodes, budget)
        this.assertContinuationState(state, input)
        locatorMatchCount += backendNodeIds.length
        if (locatorMatchCount > maxBrowserInspectionTotalLocatorMatches) {
          throw failure('ACTION_LIMIT_EXCEEDED')
        }
        locatorMatches.push({
          locator,
          backendNodeIds,
        })
      }
      const viewport = await this.layoutViewport(
        state,
        () => { this.assertContinuationState(state, input) },
        budget,
      )
      return {
        tabId: state.id,
        navigationEpoch: state.navigationEpoch,
        origin: originOf(state.view.webContents.getURL()),
        url: state.view.webContents.getURL(),
        title: state.view.webContents.getTitle(),
        frameId,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        nodes: Object.freeze(nodes),
        locatorMatches: Object.freeze(locatorMatches),
      }
    })
    this.assertContinuationState(state, input)
    return Object.freeze(result)
  }

  async readNode(
    input: Parameters<BrowserPageCdpPort['readNode']>[0],
  ): Promise<BrowserInspectionNode | undefined> {
    const state = this.continuationState(input)
    return this.restricted(state, [input.expectedOrigin], async () => {
      this.assertContinuationState(state, input)
      try {
        return await this.readInspectionNode(
          state,
          input.backendNodeId,
          () => { this.assertContinuationState(state, input) },
        )
      } catch {
        this.assertContinuationState(state, input)
        this.assertOpen(state)
        throw failure('PAGE_CHANGED')
      }
    })
  }

  async getContinuationNodeBox(
    input: Parameters<BrowserPageCdpPort['getNodeBox']>[0],
  ): Promise<BrowserInspectionNodeBox> {
    const state = this.continuationState(input)
    return this.restricted(state, [input.expectedOrigin], async () => {
      this.assertContinuationState(state, input)
      return Object.freeze(await this.nodeBox(
        state,
        input.backendNodeId,
        () => { this.assertContinuationState(state, input) },
      ))
    })
  }

  getNodeBox(
    input: Parameters<BrowserPageCdpPort['getNodeBox']>[0],
  ): Promise<BrowserInspectionNodeBox> {
    return this.getContinuationNodeBox(input)
  }

  async captureContinuationNodeScreenshot(
    input: Parameters<BrowserPageCdpPort['captureNodeScreenshot']>[0],
  ): Promise<string> {
    const state = this.continuationState(input)
    return this.restricted(state, [input.expectedOrigin], async () => {
      this.assertContinuationState(state, input)
      const assertCurrent = () => { this.assertContinuationState(state, input) }
      const currentNode = await this.readInspectionNode(state, input.backendNodeId, assertCurrent)
      if (!currentNode
        || currentNode.ignored
        || currentNode.dom.hidden
        || normalizedAccessibilityRole(currentNode.role) !== input.expectedRole
        || currentNode.name !== input.expectedName
        || currentNode.dom.tagName.toLowerCase() !== input.expectedTagName
        || currentNode.dom.inputType?.toLowerCase() !== input.expectedInputType) {
        throw failure('PAGE_CHANGED')
      }
      const current = await this.nodeBox(state, input.backendNodeId, assertCurrent)
      if (current.x !== input.clip.x
        || current.y !== input.clip.y
        || current.width !== input.clip.width
        || current.height !== input.clip.height) throw failure('PAGE_CHANGED')
      const screenshot = await this.command(state, 'Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
        clip: { ...input.clip, scale: 1 },
      }) as { data?: unknown }
      assertCurrent()
      if (typeof screenshot.data !== 'string' || screenshot.data.length === 0) {
        throw failure('INTERNAL_ERROR')
      }
      return screenshot.data
    })
  }

  captureNodeScreenshot(
    input: Parameters<BrowserPageCdpPort['captureNodeScreenshot']>[0],
  ): Promise<string> {
    return this.captureContinuationNodeScreenshot(input)
  }

  async closeContinuation(tabId: string): Promise<void> {
    const state = this.tabs.get(tabId)
    if (state) await this.closeTab(state)
  }

  async clearUserData(userId: string): Promise<void> {
    if (this.shuttingDown || this.resetOperation) throw failure('CONFLICT')
    const states = [...this.tabs.values()].filter((state) => state.userId === userId && !state.closed)
    if (states.some((state) => state.ownerExecutionId
      || state.ownerContinuationRunId
      || state.activeOperations > 0)) throw failure('CONFLICT')
    for (const state of states) await this.closeTab(state)
    const session = await this.configureSession(browserPartition(userId))
    await Promise.all([
      session.clearStorageData(),
      session.clearCache(),
    ])
  }

  async updateProxy(): Promise<void> {
    await Promise.all(this.sessionSetups.values())
    const snapshot = await this.options.proxySnapshot()
    await Promise.all([...this.sessions.entries()]
      .filter(([partition]) => partition.startsWith('persist:'))
      .map(async ([, session]) => {
        await session.setProxy(snapshot.enabled ? {
          mode: 'fixed_servers',
          ...(snapshot.proxyRules ? { proxyRules: snapshot.proxyRules } : {}),
          proxyBypassRules: snapshot.bypassRules,
        } : { mode: 'direct' })
        await session.closeAllConnections()
      }))
  }

  updateTheme(): void {
    const window = this.window
    if (!window || window.isDestroyed()) return
    window.setBackgroundColor(this.options.backgroundColor())
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.lifecycleEpoch += 1
    if (this.resetOperation) await this.resetOperation
    await Promise.allSettled([...this.acquisitions])
    await this.closeWindow()
  }

  reset(): Promise<void> {
    if (this.resetOperation) return this.resetOperation
    const operation = this.performReset()
    this.resetOperation = operation
    void operation.finally(() => {
      if (this.resetOperation === operation) this.resetOperation = undefined
    }).catch(() => undefined)
    return operation
  }

  private async performReset(): Promise<void> {
    this.lifecycleEpoch += 1
    await this.closeWindow()
    await Promise.allSettled([...this.acquisitions])
    await this.closeWindow()
  }

  async navigate(state: TargetTabState, url: string, allowedOrigins: readonly string[]): Promise<void> {
    this.assertOpen(state)
    const requestedOrigin = originOf(url)
    if (!allowedOrigins.includes(requestedOrigin)) throw failure('CAPABILITY_SCOPE_DENIED')
    await this.restricted(state, allowedOrigins, async () => {
      const navigation = this.waitForNavigation(state.view.webContents)
      try {
        await state.view.webContents.loadURL(url)
        navigation.cancel()
      } catch (error) {
        if (!isAbortedNavigation(error) || state.navigationViolation) {
          navigation.cancel()
          throw error
        }
        await navigation.promise
      }
      await this.waitForNavigation(state.view.webContents, postLoadNavigationDetectionMs).promise
    })
    await this.renderToolbar().catch(() => undefined)
  }

  async fill(state: TargetTabState, locator: string, value: string, allowedOrigin: string): Promise<void> {
    this.assertOpen(state)
    await this.restricted(state, [allowedOrigin], async () => {
      const backendNodeId = await this.resolveLocator(state, locator)
      const result = await this.command(state, 'DOM.resolveNode', { backendNodeId }) as {
        object?: { objectId?: string }
      }
      const objectId = result.object?.objectId
      if (!objectId) throw failure('INVALID_INPUT')
      const called = await this.command(state, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function(value) {
          const element = this
          if (element instanceof HTMLInputElement) {
            if (['checkbox','radio','file','button','submit','reset','image','hidden'].includes(element.type)) return false
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, value)
          } else if (element instanceof HTMLTextAreaElement) {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(element, value)
          } else if (element.isContentEditable) {
            element.textContent = value
          } else return false
          element.focus()
          element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
          element.dispatchEvent(new Event('change', { bubbles: true }))
          return true
        }`,
        arguments: [{ value }],
        returnByValue: true,
        awaitPromise: true,
      }) as { result?: { value?: unknown }; exceptionDetails?: unknown }
      if (called.exceptionDetails || called.result?.value !== true) throw failure('INVALID_INPUT')
    })
  }

  async click(state: TargetTabState, locator: string, allowedOrigin: string): Promise<void> {
    this.assertOpen(state)
    await this.restricted(state, [allowedOrigin], async () => {
      const backendNodeId = await this.resolveLocator(state, locator)
      await this.command(state, 'DOM.scrollIntoViewIfNeeded', { backendNodeId })
      const result = await this.command(state, 'DOM.getBoxModel', { backendNodeId }) as {
        model?: { content?: number[] }
      }
      const points = result.model?.content
      if (!points || points.length !== 8) throw failure('INVALID_INPUT')
      const x = (points[0]! + points[2]! + points[4]! + points[6]!) / 4
      const y = (points[1]! + points[3]! + points[5]! + points[7]!) / 4
      const navigation = this.waitForNavigation(state.view.webContents)
      state.syntheticInputOperations += 1
      try {
        await this.command(state, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x, y, button: 'left', clickCount: 1,
        })
        await this.command(state, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
        })
      } finally {
        state.syntheticInputOperations -= 1
      }
      await navigation.promise
    })
    await this.renderToolbar().catch(() => undefined)
  }

  private async setContinuationValue(
    state: TargetTabState,
    backendNodeId: number,
    kind: 'fill' | 'select',
    value: string,
  ): Promise<void> {
    const resolved = await this.command(state, 'DOM.resolveNode', { backendNodeId }) as {
      object?: { objectId?: string }
    }
    const objectId = resolved.object?.objectId
    if (!objectId) throw failure('PAGE_CHANGED')
    const called = await this.command(state, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(kind, value) {
        const element = this
        if (kind === 'select') {
          if (!(element instanceof HTMLSelectElement)) return false
          const option = Array.from(element.options).find((candidate) => candidate.value === value || candidate.text.trim() === value)
          if (!option) return false
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(element, option.value)
        } else if (element instanceof HTMLInputElement) {
          if (['checkbox','radio','file','button','submit','reset','image','hidden','password'].includes(element.type)) return false
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, value)
        } else if (element instanceof HTMLTextAreaElement) {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(element, value)
        } else if (element.isContentEditable) {
          element.textContent = value
        } else return false
        element.focus()
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
        element.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      }`,
      arguments: [{ value: kind }, { value }],
      returnByValue: true,
      awaitPromise: true,
    }) as { result?: { value?: unknown }; exceptionDetails?: unknown }
    if (called.exceptionDetails || called.result?.value !== true) throw failure('UNSUPPORTED_CONTROL')
  }

  private async assertContinuationTarget(
    state: TargetTabState,
    target: BrowserContinuationResolvedTargetInput,
  ): Promise<BrowserInspectionNode | undefined> {
    if (target.expectedRole === undefined && target.expectedName === undefined) return undefined
    const current = await this.readInspectionNode(state, target.backendNodeId)
    this.assertContinuationState(state, target)
    if (!current
      || current.ignored
      || current.dom.hidden
      || !current.enabled
      || (target.expectedRole !== undefined
        && normalizedAccessibilityRole(current.role) !== target.expectedRole)
      || (target.expectedName !== undefined && current.name !== target.expectedName)) {
      throw failure('PAGE_CHANGED')
    }
    return current
  }

  private async clickContinuationNode(state: TargetTabState, backendNodeId: number): Promise<void> {
    await this.command(state, 'DOM.scrollIntoViewIfNeeded', { backendNodeId })
    const box = await this.nodeBox(state, backendNodeId)
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await this.syntheticInput(state, async () => {
      await this.command(state, 'Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', clickCount: 1,
      })
      await this.command(state, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
      })
    })
  }

  private async syntheticInput<T>(state: TargetTabState, operation: () => Promise<T>): Promise<T> {
    state.syntheticInputOperations += 1
    try {
      return await operation()
    } finally {
      state.syntheticInputOperations -= 1
    }
  }

  currentUrl(state: TargetTabState): string {
    this.assertOpen(state)
    return state.view.webContents.getURL()
  }

  currentOrigin(state: TargetTabState): string {
    return originOf(this.currentUrl(state))
  }

  focusTab(state: TargetTabState): Promise<void> {
    return this.activate(state)
  }

  async closeTab(state: TargetTabState): Promise<void> {
    if (state.closed) return
    state.view.webContents.close()
  }

  private async createTab(input: BrowserWorkspaceAcquireInput): Promise<TargetTabState> {
    const partition = browserPartition(input.userId)
    await Promise.all([this.ensureWindow(), this.configureSession(partition)])
    const view = new this.options.WebContentsView({
      webPreferences: {
        partition,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        allowRunningInsecureContent: false,
        navigateOnDragDrop: false,
      },
    })
    await view.webContents.loadURL('about:blank')
    const continuation = continuationFromAcquire(input)
    const state: TargetTabState = {
      id: randomUUID(),
      userId: input.userId,
      workflowId: input.workflowId,
      partition,
      view,
      continuation,
      reuseIdentity: continuation && continuationReuseIdentity(continuation),
      continuationBound: false,
      navigationEpoch: 0,
      activeOperations: 0,
      syntheticInputOperations: 0,
      loading: false,
      lastActiveAt: Date.now(),
      closed: false,
    }
    this.tabs.set(state.id, state)
    const guard = (event: NavigationEvent, url: string) => this.guardNavigation(state, event, url)
    view.webContents.on('will-navigate', guard)
    view.webContents.on('will-redirect', guard)
    view.webContents.on('will-attach-webview', (event: NavigationEvent) => event.preventDefault())
    const renderNavigationMetadata = () => {
      if (!state.loading) void this.renderToolbar().catch(() => undefined)
    }
    const navigationChanged = () => {
      state.navigationEpoch += 1
      state.lastActiveAt = Date.now()
      this.emitPageInvalidated(state.id)
      renderNavigationMetadata()
    }
    const navigationStarted = (...args: unknown[]) => {
      const details = args[0] as { isMainFrame?: boolean } | undefined
      if (details?.isMainFrame === false || args[3] === false) return
      this.emitPageInvalidated(state.id)
    }
    view.webContents.on('page-title-updated', renderNavigationMetadata)
    view.webContents.on('did-start-navigation', navigationStarted)
    view.webContents.on('did-navigate', navigationChanged)
    view.webContents.on('did-navigate-in-page', navigationChanged)
    view.webContents.on('did-start-loading', () => { this.setLoading(state, true) })
    view.webContents.on('did-stop-loading', () => { this.setLoading(state, false) })
    view.webContents.on('before-input-event', () => {
      void this.handleUserTakeover(state).catch(() => undefined)
    })
    view.webContents.on('before-mouse-event', (event: NavigationEvent) => {
      if (state.ownerContinuationRunId && state.syntheticInputOperations === 0) event.preventDefault()
    })
    view.webContents.on('render-process-gone', () => {
      if (!view.webContents.isDestroyed()) view.webContents.close()
      this.handleDestroyed(state)
    })
    view.webContents.on('destroyed', () => { this.handleDestroyed(state) })
    view.webContents.setWindowOpenHandler(({ url }) => {
      this.handleWindowOpen(state, url)
      return { action: 'deny' }
    })
    await this.attachDebugger(state)
    return state
  }

  private handleWindowOpen(parent: TargetTabState, url: string): void {
    const patterns = parent.continuation?.permissionMatrix['browser.open']
    if (!parent.continuationBound || !patterns?.some((pattern) => matchesHttpsUrlPattern(pattern, url))) {
      let blocked = url
      try { blocked = originOf(url) } catch { /* Keep the bounded toolbar escaping below. */ }
      this.setBlockedOrigin(parent, blocked, 'DOMAIN_BLOCKED')
      return
    }
    void this.createPopup(parent, url).catch(() => {
      this.setBlockedOrigin(parent, originOf(url), 'DOMAIN_BLOCKED')
    })
  }

  private async createPopup(parent: TargetTabState, url: string): Promise<void> {
    this.assertOpen(parent)
    const continuation = parent.continuation
    if (!continuation || !parent.continuationBound) throw failure('DOMAIN_BLOCKED')
    const child = await this.createTab(continuation)
    try {
      const patterns = continuation.permissionMatrix['browser.open'] ?? []
      child.popupPatterns = patterns
      if (parent.ownerExecutionId) {
        child.ownerExecutionId = parent.ownerExecutionId
        this.addExecutionTab(parent.ownerExecutionId, child)
      }
      const origin = originOf(url)
      child.allowedOrigins = [origin]
      try {
        await child.view.webContents.loadURL(url)
        const current = child.view.webContents.getURL()
        if (!patterns.some((pattern) => matchesHttpsUrlPattern(pattern, current))) {
          throw failure('DOMAIN_BLOCKED')
        }
        child.automationOrigins = [originOf(current)]
      } finally {
        child.allowedOrigins = undefined
      }
      this.continuationRegistry?.bindPopup(parent.id, child.id)
      child.continuationBound = this.continuationRegistry !== undefined
      if (!child.continuationBound) throw failure('PAGE_CLOSED')
      await this.activate(child)
    } catch (error) {
      await this.closeTab(child)
      throw error
    }
  }

  private handleUserTakeover(state: TargetTabState, force = false): Promise<void> {
    void this.clearContinuationHighlight(state.id).catch(() => undefined)
    const runId = state.ownerContinuationRunId
    if (!runId || (!force && state.syntheticInputOperations > 0)) return Promise.resolve()
    state.ownerContinuationRunId = undefined
    this.emitPageInvalidated(state.id)
    void this.renderToolbar().catch(() => undefined)
    const takenOver = this.continuationRegistry?.markTakenOver(state.id, runId)
    return Promise.resolve(takenOver)
  }

  private addExecutionTab(executionId: string, state: TargetTabState): void {
    const existing = this.executions.get(executionId)
    if (existing) existing.add(state)
    else this.executions.set(executionId, new Set([state]))
  }

  private removeExecutionTab(executionId: string, state: TargetTabState): void {
    const existing = this.executions.get(executionId)
    if (!existing) return
    existing.delete(state)
    if (existing.size === 0) this.executions.delete(executionId)
  }

  private async ensureWindow(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) return
    if (this.windowCreation) return this.windowCreation
    const creation = this.createWindow()
    this.windowCreation = creation
    try {
      await creation
    } finally {
      if (this.windowCreation === creation) this.windowCreation = undefined
    }
  }

  private async createWindow(): Promise<void> {
    const toolbarPartition = 'autoforge-browser-toolbar'
    await this.configureSession(toolbarPartition)
    const window = new this.options.BaseWindow({
      width: 1280, height: 820, minWidth: 900, minHeight: 600,
      show: false, title: 'AutoForge 浏览器', backgroundColor: this.options.backgroundColor(),
    })
    const toolbar = new this.options.WebContentsView({
      webPreferences: {
        partition: toolbarPartition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
      },
    })
    toolbar.webContents.on('will-navigate', (event: NavigationEvent, url: string) => {
      if (!url.startsWith('autoforge-browser://')) return
      event.preventDefault()
      void this.handleToolbarCommand(url).catch(() => undefined)
    })
    toolbar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.contentView.addChildView(toolbar)
    window.on('resize', () => this.layout())
    window.on('closed', () => {
      this.destroyViews()
      if (this.window === window) {
        this.window = undefined
        this.toolbar = undefined
      }
    })
    this.window = window
    this.toolbar = toolbar
    this.layout()
    await this.renderToolbar()
    if (this.window !== window || window.isDestroyed()) throw failure('NOT_FOUND')
    window.show()
  }

  private configureSession(partition: string): Promise<SessionPort> {
    const existing = this.sessionSetups.get(partition)
    if (existing) return existing
    const setup = this.setupSession(partition).catch((error) => {
      this.sessionSetups.delete(partition)
      this.sessions.delete(partition)
      throw error
    })
    this.sessionSetups.set(partition, setup)
    return setup
  }

  private async setupSession(partition: string): Promise<SessionPort> {
    const session = this.options.fromPartition(partition)
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.setPermissionCheckHandler?.(() => false)
    session.on?.('will-download', (event) => event.preventDefault())
    this.sessions.set(partition, session)
    if (partition.startsWith('persist:')) {
      const snapshot = await this.options.proxySnapshot()
      await session.setProxy(snapshot.enabled ? {
        mode: 'fixed_servers',
        ...(snapshot.proxyRules ? { proxyRules: snapshot.proxyRules } : {}),
        proxyBypassRules: snapshot.bypassRules,
      } : { mode: 'direct' })
    }
    return session
  }

  private async activate(state: TargetTabState, continuationRunId?: string): Promise<void> {
    this.assertOpen(state)
    if (continuationRunId !== undefined && state.ownerContinuationRunId !== continuationRunId) {
      throw failure('CANCELLED')
    }
    const window = this.window
    if (!window || window.isDestroyed()) throw failure('NOT_FOUND')
    const current = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined
    if (current && !current.closed && current !== state) window.contentView.removeChildView(current.view)
    if (current !== state) window.contentView.addChildView(state.view)
    this.activeTabId = state.id
    state.lastActiveAt = Date.now()
    this.layout()
    await this.renderToolbar().catch(() => undefined)
    if (this.window !== window || window.isDestroyed() || state.closed) throw failure('NOT_FOUND')
    if (continuationRunId !== undefined && state.ownerContinuationRunId !== continuationRunId) {
      throw failure('CANCELLED')
    }
    window.show()
    window.focus()
  }

  private layout(): void {
    const window = this.window
    const toolbar = this.toolbar
    if (!window || window.isDestroyed() || !toolbar) return
    const bounds = window.getContentBounds()
    const active = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined
    const coveringTarget = active?.loading === true || active?.blockedOrigin !== undefined
    toolbar.setBounds({ x: 0, y: 0, width: bounds.width, height: coveringTarget ? bounds.height : toolbarHeight })
    if (active && !active.closed) {
      active.view.setBounds({ x: 0, y: toolbarHeight, width: bounds.width, height: Math.max(0, bounds.height - toolbarHeight) })
    }
    if (coveringTarget) {
      window.contentView.removeChildView(toolbar)
      window.contentView.addChildView(toolbar)
    }
  }

  private setLoading(state: TargetTabState, loading: boolean): void {
    if (state.closed || state.loading === loading) return
    state.loading = loading
    if (state.id !== this.activeTabId) return
    this.layout()
    void this.renderToolbar().catch(() => undefined)
  }

  private async renderToolbar(): Promise<void> {
    const toolbar = this.toolbar
    if (!toolbar || toolbar.webContents.isDestroyed()) return
    const active = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined
    const document = toolbarDocument(
      [...this.tabs.values()].filter((tab) => !tab.closed),
      this.activeTabId,
      active ? this.automationBindingId(active, false) : undefined,
    )
    await toolbar.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`)
  }

  private async handleToolbarCommand(value: string): Promise<void> {
    const continuationCommand = parseContinuationToolbarCommand(value)
    if (continuationCommand) {
      const active = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined
      if (!active || this.automationBindingId(active, true) !== continuationCommand.bindingId) return
      const handlers = this.continuationCommandHandlers
      if (!handlers) return
      if (continuationCommand.action === 'stop') await handlers.stop(continuationCommand.bindingId)
      else await handlers.takeOver(continuationCommand.bindingId)
      return
    }
    let command: string
    let id: string | undefined
    try {
      const url = new URL(value)
      command = url.hostname
      id = url.pathname.slice(1) || undefined
    } catch { return }
    const active = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined
    if (command === 'activate' && id) {
      const tab = this.tabs.get(id)
      if (tab && !tab.closed) {
        if (active && active !== tab) await this.handleUserTakeover(active, true)
        await this.activate(tab)
      }
      return
    }
    if (command === 'close' && id) {
      const tab = this.tabs.get(id)
      if (tab) await this.closeTab(tab)
      return
    }
    if (!active || active.closed) return
    const history = active.view.webContents.navigationHistory
    if (command === 'back' && history.canGoBack()) {
      await this.handleUserTakeover(active, true)
      history.goBack()
    }
    if (command === 'forward' && history.canGoForward()) {
      await this.handleUserTakeover(active, true)
      history.goForward()
    }
    if (command === 'reload') {
      await this.handleUserTakeover(active, true)
      active.view.webContents.reload()
    }
  }

  private automationBindingId(state: TargetTabState, requireCurrentLease: boolean): string | undefined {
    const registry = this.continuationRegistry
    const continuation = state.continuation
    const ownerRunId = state.ownerContinuationRunId
    if (!registry || !continuation || !state.continuationBound || !ownerRunId || state.closed) return undefined
    const binding = registry.list(state.userId, continuation.conversationId)
      .find((candidate) => candidate.tabId === state.id)
    if (!binding) return undefined
    if (!requireCurrentLease) return binding.bindingId
    const lease = registry.currentLease(binding.bindingId)
    return lease
      && lease.binding.bindingId === binding.bindingId
      && lease.binding.tabId === state.id
      && lease.runId === ownerRunId
      ? binding.bindingId
      : undefined
  }

  private guardNavigation(state: TargetTabState, event: NavigationEvent, url: string): void {
    let origin: string
    try { origin = originOf(url) } catch { event.preventDefault(); return }
    if (state.popupPatterns) {
      if (!state.popupPatterns.some((pattern) => matchesHttpsUrlPattern(pattern, url))) {
        event.preventDefault()
        state.navigationViolation = failure('DOMAIN_BLOCKED')
        this.setBlockedOrigin(state, origin, 'DOMAIN_BLOCKED')
        return
      }
      this.setBlockedOrigin(state, undefined)
      return
    }
    const restrictedOrigins = state.allowedOrigins ?? (state.ownerExecutionId ? state.automationOrigins : undefined)
    if (restrictedOrigins && !restrictedOrigins.includes(origin)) {
      event.preventDefault()
      state.navigationViolation = failure('CAPABILITY_SCOPE_DENIED')
      this.setBlockedOrigin(state, origin, 'CAPABILITY_SCOPE_DENIED')
      return
    }
    this.setBlockedOrigin(state, undefined)
  }

  private setBlockedOrigin(
    state: TargetTabState,
    origin: string | undefined,
    code?: AppErrorCode,
  ): void {
    if (state.closed || (state.blockedOrigin === origin && state.blockedErrorCode === code)) return
    state.blockedOrigin = origin
    state.blockedErrorCode = origin === undefined ? undefined : code
    if (state.id !== this.activeTabId) return
    this.layout()
    void this.renderToolbar().catch(() => undefined)
  }

  private async restricted<T>(
    state: TargetTabState,
    allowedOrigins: readonly string[],
    action: () => Promise<T>,
  ): Promise<T> {
    this.assertOpen(state)
    if (allowedOrigins.length < 1
      || new Set(allowedOrigins).size !== allowedOrigins.length
      || allowedOrigins.some((origin) => originOf(origin) !== origin)) {
      throw failure('CAPABILITY_SCOPE_DENIED')
    }
    const executionId = state.ownerExecutionId
    const continuationRunId = state.ownerContinuationRunId
    if (!executionId && !continuationRunId) throw failure('CANCELLED')
    state.activeOperations += 1
    state.allowedOrigins = [...allowedOrigins]
    state.navigationViolation = undefined
    this.setBlockedOrigin(state, undefined)
    try {
      let result!: T
      let problem: unknown
      try { result = await action() } catch (error) { problem = error }
      const violation = state.navigationViolation
      if (violation) throw violation
      if (problem) throw problem
      if (state.ownerExecutionId !== executionId
        || state.ownerContinuationRunId !== continuationRunId) throw failure('CANCELLED')
      const current = state.view.webContents.getURL()
      if (current !== 'about:blank' && !allowedOrigins.includes(originOf(current))) {
        throw failure('CAPABILITY_SCOPE_DENIED')
      }
      state.automationOrigins = [...allowedOrigins]
      return result
    } finally {
      state.activeOperations -= 1
      if (state.activeOperations === 0) {
        state.allowedOrigins = undefined
        state.navigationViolation = undefined
        if (!state.ownerExecutionId && !state.ownerContinuationRunId) state.automationOrigins = undefined
      }
    }
  }

  private continuationState(input: { tabId: string; runId: string }): TargetTabState {
    const state = this.tabs.get(input.tabId)
    if (!state || state.closed || state.view.webContents.isDestroyed()) throw failure('PAGE_CLOSED')
    if (state.ownerContinuationRunId !== input.runId) {
      throw failure(state.ownerContinuationRunId ? 'PAGE_BUSY' : 'CANCELLED')
    }
    return state
  }

  private assertContinuationState(
    state: TargetTabState,
    input: {
      runId: string
      expectedOrigin: string
      expectedNavigationEpoch: number
    },
  ): void {
    this.assertOpen(state)
    if (state.ownerContinuationRunId !== input.runId) throw failure('CANCELLED')
    if (state.navigationEpoch !== input.expectedNavigationEpoch
      || originOf(state.view.webContents.getURL()) !== input.expectedOrigin) {
      throw failure('PAGE_CHANGED')
    }
  }

  private inspectionNode(
    node: AccessibilityNodeResult,
    described: DescribedDomNode,
  ): BrowserInspectionNode {
    const dom = this.domSummary(described, this.axBoolean(node, 'readonly'))
    const protectedValue = dom.hidden
      || dom.inputType === 'password'
      || dom.inputType === 'file'
      || dom.autocomplete === 'one-time-code'
    const value = protectedValue ? undefined : this.axString(node.value)
    return Object.freeze({
      axNodeId: node.nodeId!,
      parentAxNodeId: node.parentId,
      backendNodeId: node.backendDOMNodeId ?? described.backendNodeId!,
      role: this.axString(node.role) ?? '',
      name: this.axString(node.name) ?? '',
      ...(value === undefined ? {} : { value }),
      enabled: this.axBoolean(node, 'disabled') !== true,
      ...(this.axBoolean(node, 'checked') === undefined ? {} : { checked: this.axBoolean(node, 'checked') }),
      ...(this.axBoolean(node, 'selected') === undefined ? {} : { selected: this.axBoolean(node, 'selected') }),
      ignored: node.ignored === true || this.axBoolean(node, 'hidden') === true || this.axBoolean(node, 'offscreen') === true,
      frameId: node.frameId,
      ...(this.axBoolean(node, 'scrollable') === undefined ? {} : { scrollable: this.axBoolean(node, 'scrollable') }),
      dom,
    })
  }

  private async readInspectionNode(
    state: TargetTabState,
    backendNodeId: number,
    assertCurrent?: () => void,
  ): Promise<BrowserInspectionNode | undefined> {
    const described = await this.command(state, 'DOM.describeNode', {
      backendNodeId, depth: 0, pierce: false,
    }) as { node?: DescribedDomNode }
    assertCurrent?.()
    const accessibility = await this.command(state, 'Accessibility.getPartialAXTree', {
      backendNodeId, fetchRelatives: false,
    }) as { nodes?: AccessibilityNodeResult[] }
    assertCurrent?.()
    const rawNode = accessibility.nodes?.find((node) => node.backendDOMNodeId === backendNodeId)
      ?? accessibility.nodes?.[0]
    if (!rawNode || !described.node) return undefined
    return Object.freeze(this.inspectionNode(rawNode, described.node))
  }

  private domSummary(node: DescribedDomNode, axReadOnly: boolean | undefined): BrowserInspectionDomSummary {
    const attributes = new Map<string, string>()
    for (let index = 0; index < (node.attributes?.length ?? 0); index += 2) {
      const name = node.attributes?.[index]?.toLowerCase()
      if (name) attributes.set(name, node.attributes?.[index + 1] ?? '')
    }
    const inputType = attributes.get('type')?.toLowerCase()
    const autocomplete = attributes.get('autocomplete')?.toLowerCase()
    const style = attributes.get('style')?.toLowerCase() ?? ''
    const hidden = attributes.has('hidden')
      || attributes.get('aria-hidden')?.toLowerCase() === 'true'
      || inputType === 'hidden'
      || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/u.test(style)
    const readOnly = axReadOnly === true || attributes.has('readonly') || attributes.get('aria-readonly') === 'true'
    const contentEditable = attributes.get('contenteditable')?.toLowerCase() === 'true'
    const href = attributes.get('href')
    return Object.freeze({
      tagName: node.nodeName?.toLowerCase() ?? '',
      ...(inputType === undefined ? {} : { inputType }),
      ...(autocomplete === undefined ? {} : { autocomplete }),
      ...(hidden ? { hidden: true } : {}),
      ...(readOnly ? { readOnly: true } : {}),
      ...(contentEditable ? { contentEditable: true } : {}),
      ...(href === undefined ? {} : { href }),
    })
  }

  private axString(value: AccessibilityValue | undefined): string | undefined {
    return typeof value?.value === 'string' ? value.value : undefined
  }

  private axBoolean(node: AccessibilityNodeResult, name: string): boolean | undefined {
    const value = node.properties?.find((property) => property.name === name)?.value?.value
    if (typeof value === 'boolean') return value
    if (value === 'true') return true
    if (value === 'false') return false
    return undefined
  }

  private async resolveLocatorMatches(
    state: TargetTabState,
    locator: string,
    accessibilityNodes: readonly AccessibilityNodeResult[],
    budget: InspectionCommandBudget,
  ): Promise<readonly number[]> {
    const parsed = parseLocator(locator)
    if (parsed.kind === 'role') {
      const matches = accessibilityNodes
        .filter((node) => !node.ignored
          && this.axString(node.role)?.toLowerCase() === parsed.value
          && (parsed.name === undefined || this.axString(node.name) === parsed.name)
          && typeof node.backendDOMNodeId === 'number')
        .map((node) => node.backendDOMNodeId!)
      if (matches.length > MAX_BROWSER_INSPECTION_LOCATOR_MATCHES) {
        throw failure('ACTION_LIMIT_EXCEEDED')
      }
      return Object.freeze(matches)
    }
    const document = await this.inspectionCommand(state, budget, 'DOM.getDocument', {
      depth: 0, pierce: true,
    }) as {
      root?: { nodeId?: number }
    }
    const nodeId = document.root?.nodeId
    if (!nodeId) throw failure('PAGE_CHANGED')
    let queried: { nodeIds?: number[] }
    try {
      queried = await this.inspectionCommand(state, budget, 'DOM.querySelectorAll', {
        nodeId, selector: parsed.value,
      }) as { nodeIds?: number[] }
    } catch (error) {
      const safe = toSafeAppError(error)
      if (safe.code === 'ACTION_LIMIT_EXCEEDED' || safe.code === 'CANCELLED') throw safe
      this.assertOpen(state)
      throw failure('PAGE_CHANGED')
    }
    if ((queried.nodeIds?.length ?? 0) > MAX_BROWSER_INSPECTION_LOCATOR_MATCHES) {
      throw failure('ACTION_LIMIT_EXCEEDED')
    }
    const backendNodeIds: number[] = []
    for (const matchedNodeId of queried.nodeIds ?? []) {
      const described = await this.inspectionCommand(state, budget, 'DOM.describeNode', {
        nodeId: matchedNodeId, depth: 0, pierce: false,
      }) as { node?: DescribedDomNode }
      if (typeof described.node?.backendNodeId !== 'number') throw failure('PAGE_CHANGED')
      backendNodeIds.push(described.node.backendNodeId)
    }
    return Object.freeze([...new Set(backendNodeIds)])
  }

  private async nodeBox(
    state: TargetTabState,
    backendNodeId: number,
    assertCurrent?: () => void,
  ): Promise<BrowserInspectionNodeBox> {
    const result = await this.command(state, 'DOM.getBoxModel', { backendNodeId }) as {
      model?: { content?: number[] }
    }
    assertCurrent?.()
    const points = result.model?.content
    if (!points || points.length !== 8 || points.some((value) => !Number.isFinite(value))) {
      throw failure('PAGE_CHANGED')
    }
    const xs = [points[0]!, points[2]!, points[4]!, points[6]!]
    const ys = [points[1]!, points[3]!, points[5]!, points[7]!]
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    const viewport = await this.layoutViewport(state, assertCurrent)
    return {
      x,
      y,
      width: Math.max(...xs) - x,
      height: Math.max(...ys) - y,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
    }
  }

  private async layoutViewport(
    state: TargetTabState,
    assertCurrent?: () => void,
    budget?: InspectionCommandBudget,
  ): Promise<{ width: number; height: number }> {
    const result = await (budget
      ? this.inspectionCommand(state, budget, 'Page.getLayoutMetrics')
      : this.command(state, 'Page.getLayoutMetrics')) as {
      cssLayoutViewport?: { clientWidth?: number; clientHeight?: number }
      layoutViewport?: { clientWidth?: number; clientHeight?: number }
    }
    assertCurrent?.()
    const viewport = result.cssLayoutViewport ?? result.layoutViewport
    if (typeof viewport?.clientWidth !== 'number' || typeof viewport.clientHeight !== 'number') {
      throw failure('PAGE_CHANGED')
    }
    return { width: viewport.clientWidth, height: viewport.clientHeight }
  }

  private async attachDebugger(state: TargetTabState): Promise<void> {
    const target = state.view.webContents.debugger
    if (!target.isAttached()) target.attach('1.3')
    await target.sendCommand('DOM.enable')
    await target.sendCommand('Accessibility.enable')
  }

  private command(state: TargetTabState, method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.assertOpen(state)
    return state.view.webContents.debugger.sendCommand(method, params)
  }

  private inspectionCommand(
    state: TargetTabState,
    budget: InspectionCommandBudget,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (budget.signal?.aborted) return Promise.reject(failure('CANCELLED'))
    if (Date.now() >= budget.deadlineAt || ++budget.calls > maxBrowserInspectionCdpCalls) {
      return Promise.reject(failure('ACTION_LIMIT_EXCEEDED'))
    }
    const operation = this.command(state, method, params)
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (result: { value: unknown } | { error: unknown }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        budget.signal?.removeEventListener('abort', onAbort)
        if ('error' in result) reject(result.error)
        else resolve(result.value)
      }
      const onAbort = () => { finish({ error: failure('CANCELLED') }) }
      const timer = setTimeout(() => {
        finish({ error: failure('ACTION_LIMIT_EXCEEDED') })
      }, Math.max(0, budget.deadlineAt - Date.now()))
      budget.signal?.addEventListener('abort', onAbort, { once: true })
      if (budget.signal?.aborted) onAbort()
      void operation.then(
        (value) => {
          let serialized: string | undefined
          try { serialized = JSON.stringify(value) } catch { /* fail closed below */ }
          if (serialized === undefined) {
            finish({ error: failure('ACTION_LIMIT_EXCEEDED') })
            return
          }
          budget.bytes += Buffer.byteLength(serialized, 'utf8')
          if (budget.bytes > MAX_BROWSER_INSPECTION_RAW_BYTES) {
            finish({ error: failure('ACTION_LIMIT_EXCEEDED') })
            return
          }
          finish({ value })
        },
        (error) => { finish({ error }) },
      )
    })
  }

  private async resolveLocator(state: TargetTabState, locator: string): Promise<number> {
    const parsed = parseLocator(locator)
    if (parsed.kind === 'css') {
      const document = await this.command(state, 'DOM.getDocument', { depth: -1, pierce: true }) as {
        root?: { nodeId?: number }
      }
      const nodeId = document.root?.nodeId
      if (!nodeId) throw failure('INVALID_INPUT')
      let queried: { nodeIds?: number[] }
      try {
        queried = await this.command(state, 'DOM.querySelectorAll', { nodeId, selector: parsed.value }) as {
          nodeIds?: number[]
        }
      } catch {
        this.assertOpen(state)
        throw failure('INVALID_INPUT')
      }
      if (queried.nodeIds?.length !== 1) throw failure('INVALID_INPUT')
      const described = await this.command(state, 'DOM.describeNode', { nodeId: queried.nodeIds[0] }) as {
        node?: { backendNodeId?: number }
      }
      if (!described.node?.backendNodeId) throw failure('INVALID_INPUT')
      return described.node.backendNodeId
    }

    const document = await this.command(state, 'DOM.getDocument', { depth: 0 }) as {
      root?: { nodeId?: number }
    }
    const nodeId = document.root?.nodeId
    if (!nodeId) throw failure('INVALID_INPUT')
    const result = await this.command(state, 'Accessibility.queryAXTree', {
      nodeId,
      role: parsed.value,
      ...(parsed.name === undefined ? {} : { accessibleName: parsed.name }),
    }) as {
      nodes?: Array<{
        backendDOMNodeId?: number
        ignored?: boolean
        role?: { value?: unknown }
        name?: { value?: unknown }
      }>
    }
    const matches = new Set((result.nodes ?? [])
      .filter((node) => !node.ignored
        && node.role?.value === parsed.value
        && (parsed.name === undefined || node.name?.value === parsed.name)
        && typeof node.backendDOMNodeId === 'number')
      .map((node) => node.backendDOMNodeId as number))
    if (matches.size !== 1) throw failure('INVALID_INPUT')
    return [...matches][0]!
  }

  private waitForNavigation(
    contents: WebContentsPort,
    detectionMs = navigationDetectionMs,
  ): { promise: Promise<void>; cancel(): void } {
    let cancel: () => void = () => undefined
    const promise = new Promise<void>((resolve, reject) => {
      let started = false
      let sameDocument = false
      let settled = false
      const timers: {
        detection?: ReturnType<typeof setTimeout>
        maximum?: ReturnType<typeof setTimeout>
      } = {}
      const finish = (error?: AppError) => {
        if (settled) return
        settled = true
        if (timers.detection) clearTimeout(timers.detection)
        if (timers.maximum) clearTimeout(timers.maximum)
        contents.removeListener('did-start-navigation', onStart)
        contents.removeListener('did-stop-loading', onStop)
        contents.removeListener('did-fail-load', onFail)
        contents.removeListener('did-navigate-in-page', onInPage)
        contents.removeListener('destroyed', onDestroyed)
        if (error) reject(error)
        else resolve()
      }
      cancel = () => finish()
      const onStart = (...args: unknown[]) => {
        const details = args[0] as { isMainFrame?: boolean; isSameDocument?: boolean } | undefined
        const deprecatedIsMainFrame = args[3]
        if (details?.isMainFrame === false || deprecatedIsMainFrame === false) return
        started = true
        sameDocument = details?.isSameDocument === true || args[2] === true
      }
      const onStop = () => { if (started) finish() }
      const onFail = (...args: unknown[]) => {
        const details = args[0] as { errorCode?: number; isMainFrame?: boolean } | undefined
        const errorCode = details?.errorCode ?? args[1]
        const deprecatedIsMainFrame = args[4]
        if (details?.isMainFrame === false || deprecatedIsMainFrame === false) return
        if (errorCode === -3) return
        if (started) finish(failure('INTERNAL_ERROR'))
      }
      const onInPage = () => { if (started && sameDocument) finish() }
      const onDestroyed = () => { finish() }
      contents.on('did-start-navigation', onStart)
      contents.on('did-stop-loading', onStop)
      contents.on('did-fail-load', onFail)
      contents.on('did-navigate-in-page', onInPage)
      contents.on('destroyed', onDestroyed)
      timers.detection = setTimeout(() => { if (!started) finish() }, detectionMs)
      timers.maximum = setTimeout(() => { finish(failure('WORKER_TIMEOUT')) }, 30_000)
    })
    return { promise, cancel: () => cancel() }
  }

  private handleDestroyed(state: TargetTabState): void {
    if (state.closed) return
    state.closed = true
    this.highlightedContinuationTabs.delete(state.id)
    this.emitPageInvalidated(state.id)
    this.tabs.delete(state.id)
    if (state.ownerExecutionId) this.removeExecutionTab(state.ownerExecutionId, state)
    try { this.continuationRegistry?.markClosed(state.id, 'PAGE_CLOSED') } catch { /* Audit persistence cannot revive a closed renderer. */ }
    try {
      if (state.view.webContents.debugger.isAttached()) state.view.webContents.debugger.detach()
    } catch { /* already detached by renderer teardown */ }
    if (this.activeTabId === state.id) {
      this.activeTabId = undefined
      const next = [...this.tabs.values()].find((tab) => !tab.closed)
      if (!this.closingViews && next && this.window && !this.window.isDestroyed()) {
        void this.activate(next).catch(() => undefined)
      }
    }
    if (!this.closingViews) void this.renderToolbar().catch(() => undefined)
  }

  private emitPageInvalidated(tabId: string): void {
    void this.clearContinuationHighlight(tabId).catch(() => undefined)
    for (const listener of this.pageInvalidationListeners) {
      try { listener(tabId) } catch { /* Inspector cleanup cannot interrupt browser lifecycle. */ }
    }
  }

  private destroyViews(): void {
    this.closingViews = true
    try {
      for (const state of [...this.tabs.values()]) {
        if (!state.view.webContents.isDestroyed()) state.view.webContents.close()
      }
      if (this.toolbar && !this.toolbar.webContents.isDestroyed()) this.toolbar.webContents.close()
      this.tabs.clear()
      this.executions.clear()
      this.activeTabId = undefined
    } finally {
      this.closingViews = false
    }
  }

  private async closeWindow(): Promise<void> {
    const window = this.window
    this.destroyViews()
    if (!window || window.isDestroyed()) {
      if (this.window === window) {
        this.window = undefined
        this.toolbar = undefined
      }
      return
    }
    await new Promise<void>((resolve) => {
      window.on('closed', resolve)
      window.close()
    })
  }

  private assertOpen(state: TargetTabState): void {
    if (state.closed || state.view.webContents.isDestroyed()) throw failure('NOT_FOUND')
  }
}
