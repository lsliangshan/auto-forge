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
  constructor(private readonly respond: (method: string, params?: unknown) => unknown) {}
  isAttached() { return this.attached }
  attach() { this.attached = true }
  detach() { this.attached = false }
  async sendCommand(method: string, params?: unknown) {
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

  constructor(readonly session: FakeSession, respond: (method: string, params?: unknown) => unknown) {
    super()
    this.debugger = new FakeDebugger(respond)
  }

  async loadURL(url: string) {
    this.loaded.push(url)
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
  ) {
    this.webContents = new FakeWebContents(session, respond)
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
  getContentBounds() { return { x: 0, y: 0, width: 1200, height: 800 } }
  isDestroyed() { return this.destroyed }
  close() { if (!this.destroyed) { this.destroyed = true; this.emit('closed') } }
}

function createHarness(respond: (method: string, params?: unknown) => unknown = () => ({})) {
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
      const view = new FakeView(options, fromPartition(partition), respond)
      views.push(view)
      return view
    }
  }
  class WindowConstructor {
    constructor() { const window = new FakeBaseWindow(); windows.push(window); return window }
  }
  const proxySnapshot = vi.fn(async () => ({
    enabled: true,
    proxyRules: 'http=http://127.0.0.1:7890;https=http://127.0.0.1:7890',
    bypassRules: '<local>',
  }))
  const workspace = new ElectronBrowserWorkspace({
    BaseWindow: WindowConstructor as never,
    WebContentsView: ViewConstructor as never,
    fromPartition: fromPartition as never,
    proxySnapshot,
  })
  return { workspace, sessions, views, windows, fromPartition, proxySnapshot }
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
    const { workspace, views, windows } = createHarness()
    const first = await acquire(workspace, 'exec_1', 'user_1', 'workflow.one')
    await workspace.releaseExecution('exec_1')
    const reused = await acquire(workspace, 'exec_2', 'user_1', 'workflow.one')
    const secondWorkflow = await acquire(workspace, 'exec_3', 'user_1', 'workflow.two')
    const secondUser = await acquire(workspace, 'exec_4', 'user_2', 'workflow.one')

    expect(windows).toHaveLength(1)
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
    await first.open('https://www.baidu.com', 'https://www.baidu.com')

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

  it('blocks non-HTTPS and out-of-scope navigation while allowing released user navigation', async () => {
    const { workspace, views } = createHarness()
    const tab = await acquire(workspace, 'exec_1')
    await tab.open('https://www.baidu.com', 'https://www.baidu.com')
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
    await tab.open('https://www.baidu.com', 'https://www.baidu.com')
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
    await tab.open('https://www.baidu.com', 'https://www.baidu.com')
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
    await tab.open('https://www.baidu.com', 'https://www.baidu.com')
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
    await tab.open('https://www.baidu.com', 'https://www.baidu.com')

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
    await tab.open('https://www.baidu.com', 'https://www.baidu.com')

    await expect(tab.fill('css=[', 'value', 'https://www.baidu.com'))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
