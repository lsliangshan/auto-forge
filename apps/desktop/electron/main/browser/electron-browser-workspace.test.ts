import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  ElectronBrowserWorkspace,
  browserPartition,
  type BrowserWorkspaceTab,
} from './electron-browser-workspace.js'

class FakeSession extends EventEmitter {
  readonly setProxy = vi.fn(async () => undefined)
  readonly closeAllConnections = vi.fn(async () => undefined)
  readonly setPermissionRequestHandler = vi.fn()
  readonly setPermissionCheckHandler = vi.fn()
}

class FakeDebugger {
  attached = false
  readonly commands: Array<{ method: string; params?: unknown }> = []
  constructor(
    private readonly respond: (method: string, params?: unknown) => unknown,
    private readonly documentReady: () => boolean,
    private readonly requireDocumentBeforeCommands: boolean,
  ) {}
  isAttached() { return this.attached }
  attach() { this.attached = true }
  detach() { this.attached = false }
  async sendCommand(method: string, params?: unknown) {
    if (this.requireDocumentBeforeCommands && !this.documentReady()) {
      throw new Error('Renderer document is not initialized')
    }
    this.commands.push({ method, params })
    return this.respond(method, params)
  }
}

class FakeWebContents extends EventEmitter {
  static nextId = 0
  readonly id = ++FakeWebContents.nextId
  readonly debugger: FakeDebugger
  readonly navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => false,
    goBack: vi.fn(),
    goForward: vi.fn(),
  }
  readonly reload = vi.fn()
  readonly loaded: string[] = []
  windowOpenHandler?: (details: { url: string }) => { action: string }
  destroyed = false
  currentUrl = 'about:blank'
  title = ''

  constructor(
    readonly session: FakeSession,
    respond: (method: string, params?: unknown) => unknown,
    requireDocumentBeforeDebugger: boolean,
    private readonly beforeLoad?: (url: string) => Promise<void>,
  ) {
    super()
    this.debugger = new FakeDebugger(respond, () => this.loaded.length > 0, requireDocumentBeforeDebugger)
  }

  async loadURL(url: string) {
    this.loaded.push(url)
    await this.beforeLoad?.(url)
    this.currentUrl = url
    this.emit('did-navigate', {}, url)
  }
  getURL() { return this.currentUrl }
  getTitle() { return this.title }
  isDestroyed() { return this.destroyed }
  close() { if (!this.destroyed) { this.destroyed = true; this.emit('destroyed') } }
  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }) { this.windowOpenHandler = handler }
}

class FakeView {
  readonly webContents: FakeWebContents
  readonly bounds: Array<{ x: number; y: number; width: number; height: number }> = []
  constructor(
    readonly options: Record<string, unknown>,
    session: FakeSession,
    respond: (method: string, params?: unknown) => unknown,
    requireDocumentBeforeDebugger: boolean,
    beforeLoad?: (url: string) => Promise<void>,
  ) {
    this.webContents = new FakeWebContents(session, respond, requireDocumentBeforeDebugger, beforeLoad)
  }
  setBounds(bounds: { x: number; y: number; width: number; height: number }) { this.bounds.push(bounds) }
}

class FakeBaseWindow extends EventEmitter {
  readonly children: FakeView[] = []
  readonly contentView = {
    addChildView: (view: FakeView) => { if (!this.children.includes(view)) this.children.push(view) },
    removeChildView: (view: FakeView) => { this.children.splice(this.children.indexOf(view), 1) },
  }
  destroyed = false
  readonly show = vi.fn()
  readonly focus = vi.fn()
  readonly setBackgroundColor = vi.fn()
  constructor(readonly options: Record<string, unknown>) { super() }
  getContentBounds() { return { x: 0, y: 0, width: 1200, height: 800 } }
  isDestroyed() { return this.destroyed }
  close() { if (!this.destroyed) { this.destroyed = true; this.emit('closed') } }
}

function createHarness(
  respond: (method: string, params?: unknown) => unknown = () => ({}),
  requireDocumentBeforeDebugger = false,
  beforeLoad?: (url: string) => Promise<void>,
) {
  const sessions = new Map<string, FakeSession>()
  const views: FakeView[] = []
  const windows: FakeBaseWindow[] = []
  const fromPartition = vi.fn((partition: string) => {
    let value = sessions.get(partition)
    if (!value) { value = new FakeSession(); sessions.set(partition, value) }
    return value
  })
  class ViewConstructor {
    constructor(options: Record<string, unknown> = {}) {
      const partition = String((options.webPreferences as { partition?: string } | undefined)?.partition ?? 'toolbar')
      const view = new FakeView(options, fromPartition(partition), respond, requireDocumentBeforeDebugger, beforeLoad)
      views.push(view)
      return view
    }
  }
  class WindowConstructor {
    constructor(options: Record<string, unknown>) { const window = new FakeBaseWindow(options); windows.push(window); return window }
  }
  const proxySnapshot = vi.fn(async () => ({
    enabled: true,
    proxyRules: 'http=http://127.0.0.1:7890;https=http://127.0.0.1:7890',
    bypassRules: '<local>',
  }))
  const backgroundColor = vi.fn(() => '#f3f5f8')
  const workspace = new ElectronBrowserWorkspace({
    BaseWindow: WindowConstructor as never,
    WebContentsView: ViewConstructor as never,
    fromPartition: fromPartition as never,
    proxySnapshot,
    backgroundColor,
  })
  return { workspace, sessions, views, windows, fromPartition, proxySnapshot, backgroundColor }
}

async function acquire(
  workspace: ElectronBrowserWorkspace,
  executionId: string,
  userId = 'user_1',
  workflowId = 'workflow.one',
): Promise<BrowserWorkspaceTab> {
  return workspace.acquire({ executionId, userId, workflowId })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('ElectronBrowserWorkspace', () => {
  it('uses a stable opaque persistent partition per AutoForge user', () => {
    expect(browserPartition('user_1')).toMatch(/^persist:autoforge-browser-[a-f0-9]{32}$/)
    expect(browserPartition('user_1')).toBe(browserPartition('user_1'))
    expect(browserPartition('user_2')).not.toBe(browserPartition('user_1'))
    expect(browserPartition('user_1')).not.toContain('user_1')
  })

  it('creates one BaseWindow and secure switchable target tabs sharing only the same user session', async () => {
    const { workspace, views, windows, backgroundColor } = createHarness()
    const first = await acquire(workspace, 'exec_1', 'user_1', 'workflow.one')
    await workspace.releaseExecution('exec_1')
    const reused = await acquire(workspace, 'exec_2', 'user_1', 'workflow.one')
    const secondWorkflow = await acquire(workspace, 'exec_3', 'user_1', 'workflow.two')
    const secondUser = await acquire(workspace, 'exec_4', 'user_2', 'workflow.one')

    expect(windows).toHaveLength(1)
    expect(windows[0]!.options.backgroundColor).toBe('#f3f5f8')
    backgroundColor.mockReturnValue('#11151c')
    const updateTheme = Reflect.get(workspace, 'updateTheme') as unknown
    expect(updateTheme).toBeTypeOf('function')
    if (typeof updateTheme === 'function') updateTheme.call(workspace)
    expect(windows[0]!.setBackgroundColor).toHaveBeenLastCalledWith('#11151c')
    expect(reused).toBe(first)
    expect(secondWorkflow).not.toBe(first)
    expect(secondUser).not.toBe(first)
    const targetPreferences = views.slice(1).map((view) => view.options.webPreferences)
    expect(targetPreferences[0]).toMatchObject({
      partition: browserPartition('user_1'), nodeIntegration: false, contextIsolation: true,
      sandbox: true, webSecurity: true, webviewTag: false, allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
    })
    expect(targetPreferences[1]).toMatchObject({ partition: browserPartition('user_1') })
    expect(targetPreferences[2]).toMatchObject({ partition: browserPartition('user_2') })
    expect(windows[0]!.children).toHaveLength(2)
  })

  it('initializes a target document before enabling debugger domains', async () => {
    const { workspace, views } = createHarness(() => ({}), true)

    await expect(acquire(workspace, 'exec_1')).resolves.toBeDefined()
    expect(views[1]!.webContents.loaded[0]).toBe('about:blank')
  })

  it('covers the active page while it loads and restores the toolbar after loading stops', async () => {
    const { workspace, views, windows } = createHarness()
    await acquire(workspace, 'exec_1')
    const toolbar = views[0]!
    const target = views[1]!

    target.webContents.currentUrl = 'https://www.baidu.com/s?wd=热点新闻'
    target.webContents.emit('did-start-loading')
    await vi.waitFor(() => expect(toolbar.bounds.at(-1)?.height).toBe(800))
    expect(windows[0]!.children.at(-1)).toBe(toolbar)
    const loadingDocument = decodeURIComponent(toolbar.webContents.loaded.at(-1)!.split(',')[1]!)
    expect(loadingDocument).toContain('正在连接 <span>www.baidu.com</span>')
    expect(loadingDocument).toContain('请求站点')
    expect(loadingDocument).toContain('建立连接')
    expect(loadingDocument).toContain('等待响应')
    expect(loadingDocument).toContain('class="connection-orbit"')
    expect(loadingDocument).toContain('@media(prefers-reduced-motion:reduce)')

    target.webContents.emit('did-stop-loading')
    await vi.waitFor(() => expect(toolbar.bounds.at(-1)?.height).toBe(52))
  })

  it('keeps one stable loading document while navigation metadata changes', async () => {
    const { workspace, views } = createHarness()
    await acquire(workspace, 'exec_1')
    const toolbar = views[0]!
    const target = views[1]!

    const beforeLoading = toolbar.webContents.loaded.length
    target.webContents.emit('did-start-loading')
    await vi.waitFor(() => expect(toolbar.webContents.loaded).toHaveLength(beforeLoading + 1))

    target.webContents.title = '最终页面'
    target.webContents.currentUrl = 'https://example.com/final'
    target.webContents.emit('page-title-updated')
    target.webContents.emit('did-navigate')
    target.webContents.emit('did-navigate-in-page')
    await Promise.resolve()

    expect(toolbar.webContents.loaded).toHaveLength(beforeLoading + 1)

    target.webContents.emit('did-stop-loading')
    await vi.waitFor(() => expect(toolbar.webContents.loaded).toHaveLength(beforeLoading + 2))
    const settledDocument = decodeURIComponent(toolbar.webContents.loaded.at(-1)!.split(',')[1]!)
    expect(settledDocument).toContain('最终页面')
    expect(settledDocument).toContain('https://example.com/final')
  })

  it('starts persistent session setup before the browser toolbar finishes loading', async () => {
    const toolbarLoad = deferred<void>()
    let blocked = false
    const harness = createHarness(() => ({}), false, async (url) => {
      if (!blocked && url.startsWith('data:text/html')) {
        blocked = true
        await toolbarLoad.promise
      }
    })

    const acquiring = acquire(harness.workspace, 'exec_1')
    await vi.waitFor(() => expect(harness.views).toHaveLength(1))
    await Promise.resolve()
    expect(harness.proxySnapshot).toHaveBeenCalledOnce()

    toolbarLoad.resolve()
    await acquiring
  })

  it('serializes the first concurrent tab acquisitions through one BaseWindow creation', async () => {
    const { workspace, windows } = createHarness()

    await Promise.all([
      acquire(workspace, 'exec_1', 'user_1', 'workflow.one'),
      acquire(workspace, 'exec_2', 'user_1', 'workflow.two'),
    ])

    expect(windows).toHaveLength(1)
  })

  it('waits for one shared persistent session setup before creating concurrent target tabs', async () => {
    const setup = deferred<{ enabled: boolean; proxyRules: string; bypassRules: string }>()
    const harness = createHarness()
    harness.proxySnapshot.mockImplementation(() => setup.promise)

    const first = acquire(harness.workspace, 'exec_1', 'user_1', 'workflow.one')
    const second = acquire(harness.workspace, 'exec_2', 'user_1', 'workflow.two')
    await Promise.resolve()
    await Promise.resolve()

    expect(harness.views).toHaveLength(1)
    setup.resolve({ enabled: true, proxyRules: 'http=http://127.0.0.1:7890', bypassRules: '<local>' })
    await Promise.all([first, second])

    expect(harness.sessions.get(browserPartition('user_1'))?.setProxy).toHaveBeenCalledOnce()
  })

  it('keeps released tabs alive, closes explicit tabs, and destroys every webContents on window close', async () => {
    const { workspace, views, windows } = createHarness()
    const first = await acquire(workspace, 'exec_1')
    const second = await acquire(workspace, 'exec_2', 'user_1', 'workflow.two')
    await workspace.releaseExecution('exec_1')
    expect(views[1]!.webContents.destroyed).toBe(false)

    await first.close()
    expect(views[1]!.webContents.destroyed).toBe(true)
    expect(views[2]!.webContents.destroyed).toBe(false)

    windows[0]!.close()
    expect(views.every((view) => view.webContents.destroyed)).toBe(true)
    await expect(second.url()).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('discards a crashed renderer instead of reusing its tab', async () => {
    const { workspace, views } = createHarness()
    const first = await acquire(workspace, 'exec_1')
    const target = views[1]!.webContents

    target.emit('render-process-gone', {}, { reason: 'crashed' })
    await workspace.releaseExecution('exec_1')
    const replacement = await acquire(workspace, 'exec_2')

    expect(target.destroyed).toBe(true)
    expect(replacement).not.toBe(first)
    expect(views).toHaveLength(3)
  })

  it('does not reuse a released tab while its previous execution still has an operation in flight', async () => {
    const mousePressed = deferred<unknown>()
    const respond = (method: string) => ({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'Accessibility.queryAXTree': {
        nodes: [{ backendDOMNodeId: 80, ignored: false, role: { value: 'button' }, name: { value: '百度一下' } }],
      },
      'DOM.getBoxModel': { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } },
    } as Record<string, unknown>)[method]
      ?? (method === 'Input.dispatchMouseEvent' ? mousePressed.promise : {})
    const { workspace, views } = createHarness(respond)
    const first = await acquire(workspace, 'exec_1')
    await first.open('https://www.baidu.com', ['https://www.baidu.com'])

    const clicking = first.click('role=button[name="百度一下"]', 'https://www.baidu.com')
    while (!views[1]!.webContents.debugger.commands.some(({ method }) => method === 'Input.dispatchMouseEvent')) {
      await Promise.resolve()
    }
    await workspace.releaseExecution('exec_1')
    const replacement = await acquire(workspace, 'exec_2')

    expect(replacement).not.toBe(first)
    mousePressed.resolve({})
    await expect(clicking).rejects.toMatchObject({ code: 'CANCELLED' })
  })

  it('denies remote permissions and applies proxy changes to every live persistent session', async () => {
    const { workspace, sessions } = createHarness()
    await acquire(workspace, 'exec_1', 'user_1')
    await acquire(workspace, 'exec_2', 'user_2')
    await workspace.updateProxy()

    const persistent = [...sessions.entries()].filter(([partition]) => partition.startsWith('persist:'))
    expect(persistent).toHaveLength(2)
    for (const [, session] of persistent) {
      expect(session.setPermissionRequestHandler).toHaveBeenCalledOnce()
      expect(session.setPermissionCheckHandler).toHaveBeenCalledOnce()
      expect(session.setProxy).toHaveBeenLastCalledWith({
        mode: 'fixed_servers',
        proxyRules: 'http=http://127.0.0.1:7890;https=http://127.0.0.1:7890',
        proxyBypassRules: '<local>',
      })
      expect(session.closeAllConnections).toHaveBeenCalled()
    }
  })

  it('closes live tabs on an AutoForge account switch without deleting persistent sessions', async () => {
    const { workspace, sessions, views, windows } = createHarness()
    await acquire(workspace, 'exec_1', 'user_1')
    await acquire(workspace, 'exec_2', 'user_1', 'workflow.two')
    const partition = browserPartition('user_1')
    const focusCalls = windows[0]!.focus.mock.calls.length

    await workspace.reset()
    await Promise.resolve()

    expect(views.every((view) => view.webContents.destroyed)).toBe(true)
    expect(windows[0]!.destroyed).toBe(true)
    expect(windows[0]!.focus).toHaveBeenCalledTimes(focusCalls)
    expect(sessions.has(partition)).toBe(true)
    await acquire(workspace, 'exec_2', 'user_1')
    expect(windows).toHaveLength(2)
  })

  it('invalidates an acquire already creating its first window when reset starts', async () => {
    const { workspace, views, windows } = createHarness()

    const opening = acquire(workspace, 'exec_1', 'user_1')
    await workspace.reset()

    await expect(opening).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(windows.every((window) => window.destroyed)).toBe(true)
    expect(views.every((view) => view.webContents.destroyed)).toBe(true)
  })

  it('cancels an acquire arriving during reset without deadlocking or reopening the old partition', async () => {
    const { workspace, windows } = createHarness()
    await acquire(workspace, 'exec_1', 'user_1')

    const resetting = workspace.reset()
    const acquiring = acquire(workspace, 'exec_2', 'user_1')
    const rejected = expect(acquiring).rejects.toMatchObject({ code: 'CANCELLED' })

    await resetting
    await rejected
    expect(windows).toHaveLength(1)
    expect(windows[0]!.destroyed).toBe(true)
  })

  it('closes the visible old-user window before waiting for a stuck tab acquisition', async () => {
    const debuggerSetup = deferred<unknown>()
    let blockDebuggerSetup = false
    const respond = (method: string) => method === 'Accessibility.enable' && blockDebuggerSetup
      ? debuggerSetup.promise
      : {}
    const { workspace, views, windows } = createHarness(respond)
    await acquire(workspace, 'exec_1', 'user_1')
    blockDebuggerSetup = true
    const acquiring = acquire(workspace, 'exec_2', 'user_1', 'workflow.two')
    while (views.length < 3) await Promise.resolve()

    const resetting = workspace.reset()
    await Promise.resolve()

    expect(windows[0]!.destroyed).toBe(true)
    const rejected = expect(acquiring).rejects.toMatchObject({ code: 'CANCELLED' })
    debuggerSetup.resolve({})
    await resetting
    await rejected
    expect(windows.every((window) => window.destroyed)).toBe(true)
  })

  it('blocks non-HTTPS and out-of-scope navigation while allowing released user navigation', async () => {
    const { workspace, views } = createHarness()
    const tab = await acquire(workspace, 'exec_1')
    await tab.open('https://www.baidu.com', ['https://www.baidu.com'])
    const target = views[1]!.webContents
    const denied = { preventDefault: vi.fn() }
    target.emit('will-navigate', denied, 'https://example.com/')
    expect(denied.preventDefault).toHaveBeenCalledOnce()

    await workspace.releaseExecution('exec_1')
    const allowed = { preventDefault: vi.fn() }
    target.emit('will-navigate', allowed, 'https://example.com/')
    expect(allowed.preventDefault).not.toHaveBeenCalled()
    const unsafe = { preventDefault: vi.fn() }
    target.emit('will-navigate', unsafe, 'file:///etc/passwd')
    expect(unsafe.preventDefault).toHaveBeenCalledOnce()
    expect(target.windowOpenHandler?.({ url: 'https://example.com/' })).toEqual({ action: 'deny' })
  })

  it('covers a blank target page with the blocked redirect origin and a rebuild hint', async () => {
    const { workspace, views, windows } = createHarness()
    const tab = await acquire(workspace, 'exec_1', 'user_1', 'workflow.beijing')
    await tab.open('https://fw.bjrcgz.gov.cn/person-platform/', [
      'https://fw.bjrcgz.gov.cn',
      'https://bjt.beijing.gov.cn',
    ])
    const toolbar = views[0]!
    const target = views[1]!.webContents
    const denied = { preventDefault: vi.fn() }

    target.emit(
      'will-redirect',
      denied,
      'https://portal.bjt.beijing.gov.cn/p/login/login.html?secret=private',
    )

    expect(denied.preventDefault).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(toolbar.bounds.at(-1)?.height).toBe(800))
    const blockedDocument = decodeURIComponent(toolbar.webContents.loaded.at(-1)!.split(',')[1]!)
    expect(blockedDocument).toContain('已阻止未授权跳转')
    expect(blockedDocument).toContain('https://portal.bjt.beijing.gov.cn')
    expect(blockedDocument).toContain('添加该精确域名并重新构建')
    expect(blockedDocument).not.toContain('secret=private')
    expect(windows[0]!.children.at(-1)).toBe(toolbar)
  })

  it('allows an approved cross-origin redirect and waits for its replacement navigation', async () => {
    const { workspace, views } = createHarness()
    const tab = await acquire(workspace, 'exec_1')
    const target = views[1]!.webContents
    const initialUrl = 'https://fw.bjrcgz.gov.cn/person-platform/'
    const loginUrl = 'https://bjt.beijing.gov.cn/renzheng/open/login/goUserLogin'
    let stopped = false
    vi.spyOn(target, 'loadURL').mockImplementationOnce(async (url) => {
      target.loaded.push(url)
      target.currentUrl = url
      target.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
      target.currentUrl = loginUrl
      target.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
      target.emit('did-fail-load', {}, -3, 'ERR_ABORTED', initialUrl, true)
      setTimeout(() => {
        stopped = true
        target.emit('did-stop-loading')
      }, 5)
      throw Object.assign(new Error('navigation replaced'), { code: 'ERR_ABORTED', errno: -3, url: loginUrl })
    })

    await expect(tab.open(initialUrl, [
      'https://fw.bjrcgz.gov.cn',
      'https://bjt.beijing.gov.cn',
    ])).resolves.toBeUndefined()

    expect(stopped).toBe(true)
    expect(await tab.url()).toBe(loginUrl)
    const approved = { preventDefault: vi.fn() }
    target.emit('will-navigate', approved, 'https://fw.bjrcgz.gov.cn/person-platform/redirectLogin')
    expect(approved.preventDefault).not.toHaveBeenCalled()
    const denied = { preventDefault: vi.fn() }
    target.emit('will-navigate', denied, 'https://evil.example/')
    expect(denied.preventDefault).toHaveBeenCalledOnce()
  })

  it('waits for a delayed first-load redirect before resolving browser.open', async () => {
    vi.useFakeTimers()
    try {
      const { workspace, views } = createHarness()
      const tab = await acquire(workspace, 'exec_1')
      const target = views[1]!.webContents
      const initialUrl = 'https://fw.bjrcgz.gov.cn/person-platform/#/person-platform/overview'
      const loginUrl = 'https://bjt.beijing.gov.cn/renzheng/open/login/goUserLogin'
      vi.spyOn(target, 'loadURL').mockImplementationOnce(async (url) => {
        target.loaded.push(url)
        target.currentUrl = url
      })
      let settled = false

      const opening = tab.open(initialUrl, [
        'https://fw.bjrcgz.gov.cn',
        'https://bjt.beijing.gov.cn',
      ]).finally(() => { settled = true })
      while (!target.loaded.includes(initialUrl)) await Promise.resolve()
      await vi.advanceTimersByTimeAsync(500)

      expect(settled).toBe(false)
      target.currentUrl = loginUrl
      target.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
      target.emit('did-stop-loading')

      await opening
      expect(await tab.url()).toBe(loginUrl)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves exact CSS and accessibility locators and drives fill and click through CDP', async () => {
    const respond = (method: string) => ({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'DOM.querySelectorAll': { nodeIds: [7] },
      'DOM.describeNode': { node: { backendNodeId: 70 } },
      'DOM.resolveNode': { object: { objectId: 'object_70' } },
      'Runtime.callFunctionOn': { result: { value: true } },
      'Accessibility.queryAXTree': {
        nodes: [{ backendDOMNodeId: 80, ignored: false, role: { value: 'button' }, name: { value: '百度一下' } }],
      },
      'DOM.getBoxModel': { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } },
    } as Record<string, unknown>)[method] ?? {}
    const { workspace, views } = createHarness(respond)
    const tab = await acquire(workspace, 'exec_1')
    await tab.open('https://www.baidu.com', ['https://www.baidu.com'])
    await tab.fill('css=#kw', 'AutoForge', 'https://www.baidu.com')
    await tab.click('role=button[name="百度一下"]', 'https://www.baidu.com')

    const commands = views[1]!.webContents.debugger.commands
    expect(commands).toContainEqual({ method: 'DOM.querySelectorAll', params: { nodeId: 1, selector: '#kw' } })
    expect(commands).toContainEqual({
      method: 'Accessibility.queryAXTree',
      params: { nodeId: 1, role: 'button', accessibleName: '百度一下' },
    })
    expect(commands).toContainEqual({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x: 20, y: 30, button: 'left', clickCount: 1 },
    })
  })

  it('waits for a click-triggered main-frame navigation once loading has started', async () => {
    const respond = (method: string) => ({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'Accessibility.queryAXTree': {
        nodes: [{ backendDOMNodeId: 80, ignored: false, role: { value: 'button' }, name: { value: '百度一下' } }],
      },
      'DOM.getBoxModel': { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } },
    } as Record<string, unknown>)[method] ?? {}
    const { workspace, views } = createHarness(respond)
    const tab = await acquire(workspace, 'exec_1')
    await tab.open('https://www.baidu.com', ['https://www.baidu.com'])
    const target = views[1]!.webContents
    let settled = false

    const clicking = tab.click('role=button[name="百度一下"]', 'https://www.baidu.com')
      .finally(() => { settled = true })
    while (!target.debugger.commands.some(({ method }) => method === 'Input.dispatchMouseEvent')) {
      await Promise.resolve()
    }
    target.emit('did-start-navigation', { isMainFrame: true })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(settled).toBe(false)
    target.emit('did-stop-loading')

    await clicking
  })

  it('detects a click-triggered navigation that starts after a short asynchronous handler', async () => {
    const respond = (method: string) => ({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'Accessibility.queryAXTree': {
        nodes: [{ backendDOMNodeId: 80, ignored: false, role: { value: 'button' }, name: { value: '提交' } }],
      },
      'DOM.getBoxModel': { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } },
    } as Record<string, unknown>)[method] ?? {}
    const { workspace, views } = createHarness(respond)
    const tab = await acquire(workspace, 'exec_1')
    await tab.open('https://www.baidu.com', ['https://www.baidu.com'])
    const target = views[1]!.webContents
    let settled = false

    const clicking = tab.click('role=button[name="提交"]', 'https://www.baidu.com')
      .finally(() => { settled = true })
    while (!target.debugger.commands.some(({ method }) => method === 'Input.dispatchMouseEvent')) {
      await Promise.resolve()
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    target.emit('did-start-navigation', { isMainFrame: true })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(settled).toBe(false)
    target.emit('did-stop-loading')

    await clicking
  })

  it('reports a timeout when click navigation starts but never finishes loading', async () => {
    vi.useFakeTimers()
    try {
      const respond = (method: string) => ({
        'DOM.getDocument': { root: { nodeId: 1 } },
        'Accessibility.queryAXTree': {
          nodes: [{ backendDOMNodeId: 80, ignored: false, role: { value: 'button' }, name: { value: '提交' } }],
        },
        'DOM.getBoxModel': { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } },
      } as Record<string, unknown>)[method] ?? {}
      const { workspace, views } = createHarness(respond)
      const tab = await acquire(workspace, 'exec_1')
      const target = views[1]!.webContents
      const opening = tab.open('https://www.baidu.com', ['https://www.baidu.com'])
      while (!target.loaded.includes('https://www.baidu.com')) await Promise.resolve()
      await vi.advanceTimersByTimeAsync(1_000)
      await opening

      const clicking = tab.click('role=button[name="提交"]', 'https://www.baidu.com')
      while (!target.debugger.commands.some(({ method }) => method === 'Input.dispatchMouseEvent')) {
        await Promise.resolve()
      }
      target.emit('did-start-navigation', { isMainFrame: true })
      const rejected = expect(clicking).rejects.toMatchObject({ code: 'WORKER_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(30_000)

      await rejected
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores subframe load failures and reports a failed main-frame click navigation', async () => {
    const respond = (method: string) => ({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'Accessibility.queryAXTree': {
        nodes: [{ backendDOMNodeId: 80, ignored: false, role: { value: 'button' }, name: { value: '提交' } }],
      },
      'DOM.getBoxModel': { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } },
    } as Record<string, unknown>)[method] ?? {}
    const { workspace, views } = createHarness(respond)
    const tab = await acquire(workspace, 'exec_1')
    await tab.open('https://www.baidu.com', ['https://www.baidu.com'])
    const target = views[1]!.webContents
    let settled = false

    const clicking = tab.click('role=button[name="提交"]', 'https://www.baidu.com')
      .finally(() => { settled = true })
    while (!target.debugger.commands.some(({ method }) => method === 'Input.dispatchMouseEvent')) {
      await Promise.resolve()
    }
    target.emit('did-start-navigation', {}, 'https://www.baidu.com/next', false, true)
    target.emit('did-fail-load', {}, -2, 'failed', 'https://frame.example/', false)
    await Promise.resolve()
    expect(settled).toBe(false)
    const rejected = expect(clicking).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    target.emit('did-fail-load', {}, -2, 'failed', 'https://www.baidu.com/next', true)

    await rejected
  })

  it('finishes click navigation when a same-document navigation completes in-page', async () => {
    const respond = (method: string) => ({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'Accessibility.queryAXTree': {
        nodes: [{ backendDOMNodeId: 80, ignored: false, role: { value: 'button' }, name: { value: '目录' } }],
      },
      'DOM.getBoxModel': { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } },
    } as Record<string, unknown>)[method] ?? {}
    const { workspace, views } = createHarness(respond)
    const tab = await acquire(workspace, 'exec_1')
    await tab.open('https://www.baidu.com', ['https://www.baidu.com'])
    const target = views[1]!.webContents
    let settled = false

    const clicking = tab.click('role=button[name="目录"]', 'https://www.baidu.com')
      .finally(() => { settled = true })
    while (!target.debugger.commands.some(({ method }) => method === 'Input.dispatchMouseEvent')) {
      await Promise.resolve()
    }
    target.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    target.emit('did-navigate-in-page')
    for (let index = 0; index < 10; index += 1) await Promise.resolve()
    const settledAfterInPage = settled
    target.emit('did-stop-loading')
    await clicking

    expect(settledAfterInPage).toBe(true)
  })

  it('rejects invalid, missing, and duplicate locators', async () => {
    const respond = (method: string) => method === 'DOM.getDocument'
      ? { root: { nodeId: 1 } }
      : method === 'DOM.querySelectorAll' ? { nodeIds: [1, 2] } : {}
    const { workspace } = createHarness(respond)
    const tab = await acquire(workspace, 'exec_1')
    await tab.open('https://www.baidu.com', ['https://www.baidu.com'])

    await expect(tab.click('xpath=//button', 'https://www.baidu.com')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(tab.click('css=.duplicate', 'https://www.baidu.com')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('maps a malformed CSS selector rejected by CDP to invalid input', async () => {
    const respond = (method: string) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (method === 'DOM.querySelectorAll') throw new Error('SyntaxError: invalid selector')
      return {}
    }
    const { workspace } = createHarness(respond)
    const tab = await acquire(workspace, 'exec_1')
    await tab.open('https://www.baidu.com', ['https://www.baidu.com'])

    await expect(tab.fill('css=[', 'value', 'https://www.baidu.com'))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
