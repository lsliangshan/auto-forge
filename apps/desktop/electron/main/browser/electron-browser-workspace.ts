import { createHash, randomUUID } from 'node:crypto'
import { toSafeAppError, type AppError, type AppErrorCode } from '@autoforge/shared'
import type { NetworkProxySnapshot } from '../network/network-proxy-service.js'

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
  on(event: string, listener: (...args: any[]) => void): this
  once(event: string, listener: (...args: any[]) => void): this
  removeListener(event: string, listener: (...args: any[]) => void): this
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
  close(): void
  on(event: 'resize' | 'closed', listener: () => void): this
}

interface SessionPort {
  setProxy(config: { mode: 'direct' | 'fixed_servers'; proxyRules?: string; proxyBypassRules?: string }): Promise<void>
  closeAllConnections(): Promise<void>
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

export interface BrowserWorkspaceAcquireInput {
  executionId: string
  userId: string
  workflowId: string
}

export interface BrowserWorkspaceTab {
  open(url: string, allowedOrigins: readonly string[]): Promise<void>
  fill(locator: string, value: string, allowedOrigin: string): Promise<void>
  click(locator: string, allowedOrigin: string): Promise<void>
  url(): Promise<string>
  close(): Promise<void>
}

export interface BrowserWorkspacePort {
  acquire(input: BrowserWorkspaceAcquireInput): Promise<BrowserWorkspaceTab>
  releaseExecution(executionId: string): Promise<void> | void
  updateProxy(): Promise<void>
  reset(): Promise<void>
  shutdown(): Promise<void>
}

export interface ElectronBrowserWorkspaceOptions {
  BaseWindow: BaseWindowConstructor
  WebContentsView: WebContentsViewConstructor
  fromPartition(partition: string): SessionPort
  proxySnapshot(): Promise<NetworkProxySnapshot>
}

interface ParsedLocator {
  kind: 'css' | 'role'
  value: string
  name?: string
}

interface TargetTabState {
  id: string
  userId: string
  workflowId: string
  partition: string
  view: WebContentsViewPort
  ownerExecutionId?: string
  automationOrigins?: readonly string[]
  allowedOrigins?: readonly string[]
  navigationViolation?: AppError
  activeOperations: number
  closed: boolean
  handle?: BrowserWorkspaceTab
}

const toolbarHeight = 52
const navigationDetectionMs = 500
const roles = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption', 'cell',
  'checkbox', 'code', 'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition',
  'deletion', 'dialog', 'directory', 'document', 'emphasis', 'feed', 'figure', 'form', 'generic',
  'grid', 'gridcell', 'group', 'heading', 'img', 'insertion', 'link', 'list', 'listbox', 'listitem',
  'log', 'main', 'marquee', 'math', 'meter', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'navigation', 'none', 'note', 'option', 'paragraph', 'presentation', 'progressbar',
  'radio', 'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox',
  'separator', 'slider', 'spinbutton', 'status', 'strong', 'subscript', 'superscript', 'switch', 'tab',
  'table', 'tablist', 'tabpanel', 'term', 'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree',
  'treegrid', 'treeitem',
])

function failure(code: AppErrorCode): AppError {
  return toSafeAppError({ code })
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

function parseLocator(locator: string): ParsedLocator {
  if (locator.startsWith('css=')) {
    const value = locator.slice(4)
    if (!value || value.includes('>>')) throw failure('INVALID_INPUT')
    return { kind: 'css', value }
  }
  const match = /^role=([a-z]+)(?:\[name=("(?:[^"\\]|\\.)*")\])?$/.exec(locator)
  if (!match || !roles.has(match[1]!)) throw failure('INVALID_INPUT')
  if (!match[2]) return { kind: 'role', value: match[1]! }
  try {
    const name = JSON.parse(match[2]) as unknown
    if (typeof name !== 'string' || !name) throw failure('INVALID_INPUT')
    return { kind: 'role', value: match[1]!, name }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) throw error
    throw failure('INVALID_INPUT')
  }
}

function html(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function toolbarDocument(tabs: readonly TargetTabState[], activeId: string | undefined): string {
  const active = tabs.find((tab) => tab.id === activeId)
  const tabMarkup = tabs.map((tab) => {
    const title = tab.view.webContents.getTitle() || tab.workflowId
    return `<span class="tab${tab.id === activeId ? ' active' : ''}"><a href="autoforge-browser://activate/${tab.id}">${html(title)}</a><a class="close" href="autoforge-browser://close/${tab.id}">×</a></span>`
  }).join('')
  const address = active && !active.view.webContents.isDestroyed() ? active.view.webContents.getURL() : ''
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
  *{box-sizing:border-box}body{margin:0;background:#151922;color:#dbe4ef;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}.bar{height:52px;display:grid;grid-template-rows:26px 26px;border-bottom:1px solid #303746}.tabs{display:flex;gap:3px;align-items:end;padding:3px 6px 0;overflow:hidden}.tab{display:flex;min-width:80px;max-width:190px;background:#242a35;border-radius:5px 5px 0 0}.tab.active{background:#343d4c}.tab a{color:inherit;text-decoration:none;padding:4px 7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tab a:first-child{flex:1}.tab .close{flex:none}.nav{display:flex;align-items:center;gap:4px;padding:2px 6px;background:#202630}.nav a{color:#dbe4ef;text-decoration:none;padding:2px 7px;border-radius:4px;background:#313949}.address{flex:1;min-width:0;padding:3px 8px;border-radius:4px;background:#11151c;color:#aeb8c6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  </style></head><body><div class="bar"><div class="tabs">${tabMarkup}</div><div class="nav"><a href="autoforge-browser://back">←</a><a href="autoforge-browser://forward">→</a><a href="autoforge-browser://reload">↻</a><div class="address">${html(address)}</div></div></div></body></html>`
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

  close(): Promise<void> {
    return this.workspace.closeTab(this.state)
  }
}

export class ElectronBrowserWorkspace implements BrowserWorkspacePort {
  private window: BaseWindowPort | undefined
  private toolbar: WebContentsViewPort | undefined
  private activeTabId: string | undefined
  private readonly tabs = new Map<string, TargetTabState>()
  private readonly executions = new Map<string, TargetTabState>()
  private readonly sessions = new Map<string, SessionPort>()
  private readonly sessionSetups = new Map<string, Promise<SessionPort>>()
  private readonly acquisitions = new Set<Promise<BrowserWorkspaceTab>>()
  private windowCreation: Promise<void> | undefined
  private resetOperation: Promise<void> | undefined
  private lifecycleEpoch = 0
  private shuttingDown = false
  private closingViews = false

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
    const existing = [...this.tabs.values()].find((tab) => !tab.closed
      && !tab.ownerExecutionId
      && tab.activeOperations === 0
      && tab.userId === input.userId
      && tab.workflowId === input.workflowId)
    let state: TargetTabState
    try {
      state = existing ?? await this.createTab(input.userId, input.workflowId)
    } catch (error) {
      if (epoch !== this.lifecycleEpoch) throw failure('CANCELLED')
      throw error
    }
    if (epoch !== this.lifecycleEpoch) throw failure('CANCELLED')
    state.ownerExecutionId = input.executionId
    this.executions.set(input.executionId, state)
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
    const state = this.executions.get(executionId)
    if (!state) return
    this.executions.delete(executionId)
    if (state.ownerExecutionId === executionId) state.ownerExecutionId = undefined
    if (state.activeOperations === 0) {
      state.automationOrigins = undefined
      state.allowedOrigins = undefined
      state.navigationViolation = undefined
    }
    await this.renderToolbar().catch(() => undefined)
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
      await this.command(state, 'Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', clickCount: 1,
      })
      await this.command(state, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
      })
      await navigation.promise
    })
    await this.renderToolbar().catch(() => undefined)
  }

  currentUrl(state: TargetTabState): string {
    this.assertOpen(state)
    return state.view.webContents.getURL()
  }

  async closeTab(state: TargetTabState): Promise<void> {
    if (state.closed) return
    state.view.webContents.close()
  }

  private async createTab(userId: string, workflowId: string): Promise<TargetTabState> {
    await this.ensureWindow()
    const partition = browserPartition(userId)
    await this.configureSession(partition)
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
    const state: TargetTabState = {
      id: randomUUID(), userId, workflowId, partition, view, activeOperations: 0, closed: false,
    }
    this.tabs.set(state.id, state)
    const guard = (event: NavigationEvent, url: string) => this.guardNavigation(state, event, url)
    view.webContents.on('will-navigate', guard)
    view.webContents.on('will-redirect', guard)
    view.webContents.on('will-attach-webview', (event: NavigationEvent) => event.preventDefault())
    view.webContents.on('page-title-updated', () => { void this.renderToolbar().catch(() => undefined) })
    view.webContents.on('did-navigate', () => { void this.renderToolbar().catch(() => undefined) })
    view.webContents.on('did-navigate-in-page', () => { void this.renderToolbar().catch(() => undefined) })
    view.webContents.on('render-process-gone', () => {
      if (!view.webContents.isDestroyed()) view.webContents.close()
      this.handleDestroyed(state)
    })
    view.webContents.on('destroyed', () => { this.handleDestroyed(state) })
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    await this.attachDebugger(state)
    return state
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
      show: false, title: 'AutoForge 浏览器', backgroundColor: '#11151c',
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

  private async activate(state: TargetTabState): Promise<void> {
    this.assertOpen(state)
    const window = this.window
    if (!window || window.isDestroyed()) throw failure('NOT_FOUND')
    const current = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined
    if (current && !current.closed && current !== state) window.contentView.removeChildView(current.view)
    if (current !== state) window.contentView.addChildView(state.view)
    this.activeTabId = state.id
    this.layout()
    await this.renderToolbar().catch(() => undefined)
    if (this.window !== window || window.isDestroyed() || state.closed) throw failure('NOT_FOUND')
    window.show()
    window.focus()
  }

  private layout(): void {
    const window = this.window
    const toolbar = this.toolbar
    if (!window || window.isDestroyed() || !toolbar) return
    const bounds = window.getContentBounds()
    toolbar.setBounds({ x: 0, y: 0, width: bounds.width, height: toolbarHeight })
    const active = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined
    if (active && !active.closed) {
      active.view.setBounds({ x: 0, y: toolbarHeight, width: bounds.width, height: Math.max(0, bounds.height - toolbarHeight) })
    }
  }

  private async renderToolbar(): Promise<void> {
    const toolbar = this.toolbar
    if (!toolbar || toolbar.webContents.isDestroyed()) return
    const document = toolbarDocument([...this.tabs.values()].filter((tab) => !tab.closed), this.activeTabId)
    await toolbar.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`)
  }

  private async handleToolbarCommand(value: string): Promise<void> {
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
      if (tab && !tab.closed) await this.activate(tab)
      return
    }
    if (command === 'close' && id) {
      const tab = this.tabs.get(id)
      if (tab) await this.closeTab(tab)
      return
    }
    if (!active || active.closed) return
    const history = active.view.webContents.navigationHistory
    if (command === 'back' && history.canGoBack()) history.goBack()
    if (command === 'forward' && history.canGoForward()) history.goForward()
    if (command === 'reload') active.view.webContents.reload()
  }

  private guardNavigation(state: TargetTabState, event: NavigationEvent, url: string): void {
    let origin: string
    try { origin = originOf(url) } catch { event.preventDefault(); return }
    const restrictedOrigins = state.allowedOrigins ?? (state.ownerExecutionId ? state.automationOrigins : undefined)
    if (restrictedOrigins && !restrictedOrigins.includes(origin)) {
      event.preventDefault()
      state.navigationViolation = failure('CAPABILITY_SCOPE_DENIED')
    }
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
    if (!executionId) throw failure('CANCELLED')
    state.activeOperations += 1
    state.allowedOrigins = [...allowedOrigins]
    state.navigationViolation = undefined
    try {
      let result!: T
      let problem: unknown
      try { result = await action() } catch (error) { problem = error }
      const violation = state.navigationViolation
      if (violation) throw violation
      if (problem) throw problem
      if (state.ownerExecutionId !== executionId) throw failure('CANCELLED')
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
        if (!state.ownerExecutionId) state.automationOrigins = undefined
      }
    }
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

  private waitForNavigation(contents: WebContentsPort): { promise: Promise<void>; cancel(): void } {
    let cancel: () => void = () => undefined
    const promise = new Promise<void>((resolve, reject) => {
      let started = false
      let sameDocument = false
      let settled = false
      let detectionTimer: ReturnType<typeof setTimeout>
      let maximumTimer: ReturnType<typeof setTimeout>
      const finish = (error?: AppError) => {
        if (settled) return
        settled = true
        clearTimeout(detectionTimer)
        clearTimeout(maximumTimer)
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
      detectionTimer = setTimeout(() => { if (!started) finish() }, navigationDetectionMs)
      maximumTimer = setTimeout(() => { finish(failure('WORKER_TIMEOUT')) }, 30_000)
    })
    return { promise, cancel: () => cancel() }
  }

  private handleDestroyed(state: TargetTabState): void {
    if (state.closed) return
    state.closed = true
    this.tabs.delete(state.id)
    if (state.ownerExecutionId) this.executions.delete(state.ownerExecutionId)
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
