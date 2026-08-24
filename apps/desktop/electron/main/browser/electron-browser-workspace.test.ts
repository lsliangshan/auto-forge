import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  ElectronBrowserWorkspace,
  browserPartition,
  type BrowserWorkspaceAcquireInput,
  type BrowserWorkspaceTab,
} from './electron-browser-workspace.js'
import { BrowserContinuationRegistry } from './browser-continuation-registry.js'
import type { BrowserContinuationBindingInput } from './browser-continuation-types.js'
import {
  MAX_BROWSER_INSPECTION_LOCATOR_MATCHES,
  MAX_BROWSER_INSPECTION_RAW_BYTES,
  MAX_BROWSER_INSPECTION_RAW_NODES,
} from './browser-page-inspector.js'
import type { BrowserSessionStorageStore } from './browser-session-storage-store.js'

class FakeSession extends EventEmitter {
  readonly setProxy = vi.fn(async () => undefined)
  readonly closeAllConnections = vi.fn(async () => undefined)
  readonly clearStorageData = vi.fn(async () => undefined)
  readonly clearCache = vi.fn(async () => undefined)
  readonly setPermissionRequestHandler = vi.fn()
  readonly setPermissionCheckHandler = vi.fn()
}

class FakeDebugger extends EventEmitter {
  attached = false
  readonly commands: Array<{ method: string; params?: unknown }> = []
  constructor(
    private readonly respond: (method: string, params?: unknown) => unknown,
    private readonly documentReady: () => boolean,
    private readonly requireDocumentBeforeCommands: boolean,
  ) { super() }
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
    private readonly afterLoad?: (url: string) => string | undefined,
  ) {
    super()
    this.debugger = new FakeDebugger(respond, () => this.loaded.length > 0, requireDocumentBeforeDebugger)
  }

  async loadURL(url: string) {
    this.loaded.push(url)
    await this.beforeLoad?.(url)
    this.currentUrl = this.afterLoad?.(url) ?? url
    this.emit('did-navigate', {}, this.currentUrl)
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
  readonly backgroundColors: string[] = []
  constructor(
    readonly options: Record<string, unknown>,
    session: FakeSession,
    respond: (method: string, params?: unknown) => unknown,
    requireDocumentBeforeDebugger: boolean,
    beforeLoad?: (url: string) => Promise<void>,
    afterLoad?: (url: string) => string | undefined,
  ) {
    this.webContents = new FakeWebContents(
      session, respond, requireDocumentBeforeDebugger, beforeLoad, afterLoad,
    )
  }
  setBounds(bounds: { x: number; y: number; width: number; height: number }) { this.bounds.push(bounds) }
  setBackgroundColor(color: string) { this.backgroundColors.push(color) }
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
  afterLoad?: (url: string) => string | undefined,
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
      const view = new FakeView(
        options, fromPartition(partition), respond, requireDocumentBeforeDebugger, beforeLoad, afterLoad,
      )
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

function executionInput(
  overrides: Partial<BrowserWorkspaceAcquireInput> = {},
): BrowserWorkspaceAcquireInput {
  return {
    executionId: 'e1',
    userId: 'user_1',
    conversationId: 'conversation_1',
    chatRunId: 'chat_run_1',
    workflowId: 'workflow.one',
    workflowVersion: '1.0.0',
    source: 'installed',
    securityFingerprint: 'a'.repeat(64),
    permissionMatrix: {
      'browser.open': ['https://www.baidu.com/*'],
      'browser.click': ['https://www.baidu.com/*'],
    },
    browserContinuation: { readableRegions: ['css=main'] },
    ...overrides,
  }
}

function continuationRegistry(workspace: ElectronBrowserWorkspace) {
  const rows = new Map<string, unknown>()
  const terminalEvents: unknown[] = []
  let id = 0
  const registry = new BrowserContinuationRegistry({
    workspace,
    repository: {
      insert: vi.fn((value) => { rows.set(value.id, value); return value }),
      terminate: vi.fn((bindingId, value) => {
        terminalEvents.push({ bindingId, value })
        const current = rows.get(bindingId)
        if (!current || typeof current !== 'object') return undefined
        const updated = { ...current, ...value }
        rows.set(bindingId, updated)
        return updated as never
      }),
    },
    id: () => `binding_${++id}`,
    now: () => id,
  })
  return Object.assign(registry, { terminalEvents })
}

async function bindIdleContinuation(harness: ReturnType<typeof createHarness>) {
  const input = executionInput()
  const tab = await harness.workspace.acquire(input)
  const registry = continuationRegistry(harness.workspace)
  harness.workspace.setContinuationRegistry(registry)
  const binding = registry.bind({ ...input, tabId: tab.id } as BrowserContinuationBindingInput)
  harness.workspace.markContinuationBound(tab.id)
  await harness.workspace.releaseExecution(input.executionId)
  return { input, tab, registry, binding }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('ElectronBrowserWorkspace', () => {
  it('focuses and highlights a continuation ref only through CDP Overlay without DOM mutation', async () => {
    const { workspace, views, windows } = createHarness(() => ({}))
    const tab = await workspace.acquire(executionInput())
    await tab.open('https://www.baidu.com/form', ['https://www.baidu.com'])
    await workspace.releaseExecution('e1')
    await workspace.acquireContinuation(tab.id, 'agent_run_1')

    await workspace.focusContinuation(tab.id, 'agent_run_1')
    await workspace.highlightContinuationTarget(tab.id, 'ref_submit', {
      runId: 'agent_run_1', expectedOrigin: 'https://www.baidu.com',
      expectedNavigationEpoch: tab.navigationEpoch, backendNodeId: 99,
    })
    await workspace.clearContinuationHighlight(tab.id)

    expect(windows[0]!.focus).toHaveBeenCalled()
    expect(views[1]!.webContents.debugger.commands).toEqual(expect.arrayContaining([
      { method: 'Overlay.enable', params: undefined },
      { method: 'DOM.scrollIntoViewIfNeeded', params: { backendNodeId: 99 } },
      { method: 'Overlay.highlightNode', params: expect.objectContaining({ backendNodeId: 99 }) },
      { method: 'Overlay.hideHighlight', params: undefined },
    ]))
    expect(views[1]!.webContents.debugger.commands.some(({ method }) => (
      method === 'Runtime.callFunctionOn' || method === 'Runtime.evaluate'
        || method === 'Input.dispatchMouseEvent'
    ))).toBe(false)
  })

  it('refuses to focus a tab for an obsolete continuation run', async () => {
    const { workspace, windows } = createHarness(() => ({}))
    const tab = await workspace.acquire(executionInput())
    await tab.open('https://www.baidu.com/form', ['https://www.baidu.com'])
    await workspace.releaseExecution('e1')
    await workspace.acquireContinuation(tab.id, 'run_old')
    await workspace.releaseContinuation(tab.id, 'run_old')
    await workspace.acquireContinuation(tab.id, 'run_new')
    windows[0]!.focus.mockClear()

    await expect(workspace.focusContinuation(tab.id, 'run_old')).rejects.toMatchObject({ code: 'PAGE_BUSY' })
    expect(windows[0]!.focus).not.toHaveBeenCalled()
    await workspace.focusContinuation(tab.id, 'run_new')
    expect(windows[0]!.focus).toHaveBeenCalledOnce()
  })

  it('rechecks the exact continuation run after an async focus race', async () => {
    const gate = deferred<void>()
    let blockToolbar = false
    let toolbarBlocked = false
    const { workspace, windows } = createHarness(
      () => ({}),
      false,
      async (url) => {
        if (blockToolbar && url.startsWith('data:text/html')) {
          toolbarBlocked = true
          await gate.promise
        }
      },
    )
    const tab = await workspace.acquire(executionInput())
    await tab.open('https://www.baidu.com/form', ['https://www.baidu.com'])
    await workspace.releaseExecution('e1')
    await workspace.acquireContinuation(tab.id, 'run_old')
    windows[0]!.focus.mockClear()
    blockToolbar = true

    const focusing = workspace.focusContinuation(tab.id, 'run_old')
    await vi.waitFor(() => { expect(toolbarBlocked).toBe(true) })
    await workspace.releaseContinuation(tab.id, 'run_old')
    await workspace.acquireContinuation(tab.id, 'run_new')
    gate.resolve()

    await expect(focusing).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(windows[0]!.focus).not.toHaveBeenCalled()
  })

  it('hides an Overlay highlight when navigation races target highlighting', async () => {
    const target: { current?: FakeWebContents } = {}
    const harness = createHarness((method) => {
      if (method === 'Overlay.highlightNode') {
        target.current!.currentUrl = 'https://www.baidu.com/changed'
        target.current!.emit('did-navigate', {}, target.current!.currentUrl)
      }
      return {}
    })
    const tab = await harness.workspace.acquire(executionInput())
    target.current = harness.views[1]!.webContents
    await tab.open('https://www.baidu.com/form', ['https://www.baidu.com'])
    await harness.workspace.releaseExecution('e1')
    await harness.workspace.acquireContinuation(tab.id, 'agent_run_1')

    await expect(harness.workspace.highlightContinuationTarget(tab.id, 'ref_submit', {
      runId: 'agent_run_1', expectedOrigin: 'https://www.baidu.com',
      expectedNavigationEpoch: tab.navigationEpoch, backendNodeId: 99,
    })).rejects.toMatchObject({ code: 'PAGE_CHANGED' })
    expect(target.current!.debugger.commands).toContainEqual({ method: 'Overlay.hideHighlight', params: undefined })
  })

  it('rechecks continuation target semantics and the requested checkbox state after fixed dispatch', async () => {
    let accessibleName = '同意须知'
    const harness = createHarness((method, params) => {
      const input = params as { backendNodeId?: number } | undefined
      if (method === 'DOM.describeNode') return {
        node: { backendNodeId: input?.backendNodeId, nodeName: 'INPUT', attributes: ['type', 'checkbox'] },
      }
      if (method === 'Accessibility.getPartialAXTree') return { nodes: [{
        nodeId: 'ax_checkbox', backendDOMNodeId: input?.backendNodeId, ignored: false,
        role: { value: 'checkbox' }, name: { value: accessibleName },
        properties: [{ name: 'checked', value: { value: false } }],
      }] }
      if (method === 'DOM.getBoxModel') return { model: { content: [10, 10, 30, 10, 30, 30, 10, 30] } }
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 1200, clientHeight: 800 } }
      return {}
    })
    const tab = await harness.workspace.acquire(executionInput())
    await tab.open('https://www.baidu.com/form', ['https://www.baidu.com'])
    await harness.workspace.releaseExecution('e1')
    await harness.workspace.acquireContinuation(tab.id, 'agent_run_1')
    const input = {
      tabId: tab.id, runId: 'agent_run_1', expectedOrigin: 'https://www.baidu.com',
      expectedNavigationEpoch: tab.navigationEpoch, backendNodeId: 20,
      expectedRole: 'checkbox', expectedName: '同意须知',
      action: {
        type: 'check' as const, ref: 'ref_agree', checked: true,
        source: { kind: 'current_user' as const },
      },
    }

    await expect(harness.workspace.performContinuationAction(input))
      .rejects.toMatchObject({ code: 'PAGE_CHANGED' })
    const dispatches = harness.views[1]!.webContents.debugger.commands
      .filter(({ method }) => method === 'Input.dispatchMouseEvent')
    expect(dispatches).toHaveLength(2)

    accessibleName = '另一个控件'
    await expect(harness.workspace.performContinuationAction(input))
      .rejects.toMatchObject({ code: 'PAGE_CHANGED' })
    expect(harness.views[1]!.webContents.debugger.commands
      .filter(({ method }) => method === 'Input.dispatchMouseEvent')).toHaveLength(2)
  })

  it('adapts bounded continuation inspection commands without exposing raw DOM attributes', async () => {
    const respond = (method: string, params?: unknown) => {
      const input = params as { backendNodeId?: number; nodeId?: number; selector?: string } | undefined
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame_main' } } }
      if (method === 'Accessibility.getFullAXTree') return {
        nodes: [
          {
            nodeId: 'ax_main', backendDOMNodeId: 10, frameId: 'frame_main', ignored: false,
            role: { type: 'role', value: 'main' }, name: { type: 'computedString', value: '办事详情' },
          },
          {
            nodeId: 'ax_date', parentId: 'ax_main', backendDOMNodeId: 11, frameId: 'frame_main', ignored: false,
            role: { type: 'role', value: 'textbox' }, name: { type: 'computedString', value: '有效期至' },
            value: { type: 'string', value: '2028-06-30' },
            properties: [{ name: 'readonly', value: { type: 'boolean', value: true } }],
          },
          {
            nodeId: 'ax_hidden', parentId: 'ax_main', backendDOMNodeId: 12, frameId: 'frame_main', ignored: false,
            role: { type: 'role', value: 'textbox' }, name: { type: 'computedString', value: '内部字段' },
            value: { type: 'string', value: 'hidden-token' },
          },
          {
            nodeId: 'ax_other', backendDOMNodeId: 99, frameId: 'frame_other', ignored: false,
            role: { type: 'role', value: 'textbox' }, name: { type: 'computedString', value: '其他 frame' },
          },
        ],
      }
      if (method === 'Accessibility.getPartialAXTree') return {
        nodes: [{
          nodeId: 'ax_date', parentId: 'ax_main', backendDOMNodeId: input?.backendNodeId,
          frameId: 'frame_main', ignored: false,
          role: { type: 'role', value: 'textbox' }, name: { type: 'computedString', value: '有效期至' },
          value: { type: 'string', value: '2028-06-30' },
          properties: [{ name: 'readonly', value: { type: 'boolean', value: true } }],
        }],
      }
      if (method === 'DOM.describeNode') {
        if (input?.nodeId === 7) {
          return {
            node: {
              backendNodeId: 10, nodeName: 'MAIN', attributes: [],
              children: [{ backendNodeId: 11, nodeName: 'INPUT', attributes: ['type', 'date'] }],
            },
          }
        }
        if (input?.backendNodeId === 12) {
          return { node: { backendNodeId: 12, nodeName: 'INPUT', attributes: ['type', 'hidden', 'value', 'hidden-token'] } }
        }
        return { node: { backendNodeId: input?.backendNodeId, nodeName: input?.backendNodeId === 11 ? 'INPUT' : 'MAIN', attributes: input?.backendNodeId === 11 ? ['type', 'date', 'readonly', ''] : [] } }
      }
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (method === 'DOM.querySelectorAll') return { nodeIds: input?.selector === 'main' ? [7] : [] }
      if (method === 'Accessibility.queryAXTree') return { nodes: [] }
      if (method === 'DOM.getBoxModel') return {
        model: { content: [20, 30, 340, 30, 340, 230, 20, 230] },
      }
      if (method === 'Page.getLayoutMetrics') return {
        cssLayoutViewport: { clientWidth: 1200, clientHeight: 800 },
      }
      if (method === 'Page.captureScreenshot') return { data: 'png-data' }
      return {}
    }
    const { workspace, views } = createHarness(respond)
    const tab = await workspace.acquire(executionInput())
    await tab.open('https://www.baidu.com/detail', ['https://www.baidu.com'])
    await workspace.releaseExecution('e1')
    await workspace.acquireContinuation(tab.id, 'agent_run_1')

    const result = await workspace.readAccessibilitySnapshot({
      tabId: tab.id,
      runId: 'agent_run_1',
      expectedOrigin: 'https://www.baidu.com',
      expectedNavigationEpoch: tab.navigationEpoch,
      locators: ['role=main', 'css=main', 'css=form#login'],
    })

    expect(result).toMatchObject({
      tabId: tab.id,
      navigationEpoch: tab.navigationEpoch,
      origin: 'https://www.baidu.com',
      url: 'https://www.baidu.com/detail',
      frameId: 'frame_main',
      viewportWidth: 1200,
      viewportHeight: 800,
    })
    expect(result.nodes).toEqual([
      expect.objectContaining({ backendNodeId: 10, role: 'main', name: '办事详情', dom: { tagName: 'main' } }),
      expect.objectContaining({ backendNodeId: 11, role: 'textbox', name: '有效期至', value: '2028-06-30', dom: { tagName: 'input', inputType: 'date', readOnly: true } }),
      expect.objectContaining({ backendNodeId: 12, dom: { tagName: 'input', inputType: 'hidden', hidden: true } }),
    ])
    expect(JSON.stringify(result)).not.toContain('hidden-token')
    expect(result.locatorMatches).toEqual([
      { locator: 'role=main', backendNodeIds: [10] },
      { locator: 'css=main', backendNodeIds: [10] },
      { locator: 'css=form#login', backendNodeIds: [] },
    ])

    const box = await workspace.getContinuationNodeBox({
      tabId: tab.id, runId: 'agent_run_1', expectedOrigin: 'https://www.baidu.com',
      expectedNavigationEpoch: tab.navigationEpoch, backendNodeId: 11,
    })
    expect(box).toEqual({ x: 20, y: 30, width: 320, height: 200, viewportWidth: 1200, viewportHeight: 800 })
    await expect(workspace.captureContinuationNodeScreenshot({
      tabId: tab.id, runId: 'agent_run_1', expectedOrigin: 'https://www.baidu.com',
      expectedNavigationEpoch: tab.navigationEpoch, backendNodeId: 11,
      clip: { x: 20, y: 30, width: 320, height: 200 },
      expectedRole: 'textbox', expectedName: '有效期至', expectedTagName: 'input',
      expectedInputType: 'date',
    })).resolves.toBe('png-data')

    const commands = views[1]!.webContents.debugger.commands
    expect(commands).toContainEqual({
      method: 'Page.captureScreenshot',
      params: {
        format: 'png', fromSurface: true, captureBeyondViewport: false,
        clip: { x: 20, y: 30, width: 320, height: 200, scale: 1 },
      },
    })
    expect(commands.some(({ method }) => method === 'Runtime.evaluate')).toBe(false)
  })

  it('fails closed before describing an oversized AX tree instead of returning a partial snapshot', async () => {
    const rawNodes = [
      {
        nodeId: 'ax_main', backendDOMNodeId: 10, frameId: 'frame_main', ignored: false,
        role: { value: 'main' }, name: { value: '结果' },
      },
      {
        nodeId: 'ax_image', parentId: 'ax_main', backendDOMNodeId: 11, frameId: 'frame_main', ignored: false,
        role: { value: 'img' }, name: { value: '结果图' },
      },
      ...Array.from({ length: MAX_BROWSER_INSPECTION_RAW_NODES }, (_, index) => ({
        nodeId: `ax_${index + 100}`, parentId: 'ax_main', backendDOMNodeId: index + 100,
        frameId: 'frame_main', ignored: false, role: { value: 'row' }, name: { value: `结果 ${index}` },
      })),
      {
        nodeId: 'ax_protected', parentId: 'ax_image', backendDOMNodeId: 2_100,
        frameId: 'frame_main', ignored: false, role: { value: 'textbox' }, name: { value: '银行卡支付' },
      },
      {
        nodeId: 'ax_tail', parentId: 'ax_main', backendDOMNodeId: 2_101,
        frameId: 'frame_main', ignored: false, role: { value: 'staticText' }, name: { value: '末页公开信息' },
      },
    ]
    const respond = (method: string, params?: unknown) => {
      const input = params as { backendNodeId?: number } | undefined
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame_main' } } }
      if (method === 'Accessibility.getFullAXTree') return { nodes: rawNodes }
      if (method === 'DOM.describeNode') return {
        node: { backendNodeId: input?.backendNodeId, nodeName: 'DIV', attributes: [] },
      }
      if (method === 'Page.getLayoutMetrics') return {
        cssLayoutViewport: { clientWidth: 1200, clientHeight: 800 },
      }
      return {}
    }
    const { workspace, views } = createHarness(respond)
    const tab = await workspace.acquire(executionInput())
    await tab.open('https://www.baidu.com/results', ['https://www.baidu.com'])
    await workspace.releaseExecution('e1')
    await workspace.acquireContinuation(tab.id, 'agent_run_1')

    await expect(workspace.readAccessibilitySnapshot({
      tabId: tab.id, runId: 'agent_run_1', expectedOrigin: 'https://www.baidu.com',
      expectedNavigationEpoch: tab.navigationEpoch, locators: [],
    })).rejects.toMatchObject({ code: 'ACTION_LIMIT_EXCEEDED' })

    expect(views[1]!.webContents.debugger.commands.some(({ method }) => (
      method === 'DOM.describeNode'
    ))).toBe(false)
  })

  it('rejects the whole inspection when cumulative raw CDP responses exceed four MiB in describeNode', async () => {
    const oversizedAttribute = 'x'.repeat(MAX_BROWSER_INSPECTION_RAW_BYTES + 1)
    const test = createHarness((method, params) => {
      const input = params as { backendNodeId?: number } | undefined
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame_main' } } }
      if (method === 'Accessibility.getFullAXTree') return { nodes: [{
        nodeId: 'ax_main', backendDOMNodeId: 10, frameId: 'frame_main', ignored: false,
        role: { value: 'main' }, name: { value: '结果' },
      }] }
      if (method === 'DOM.describeNode') return {
        node: {
          backendNodeId: input?.backendNodeId, nodeName: 'DIV',
          attributes: ['data-oversized', oversizedAttribute],
        },
      }
      if (method === 'Page.getLayoutMetrics') {
        return { cssLayoutViewport: { clientWidth: 1200, clientHeight: 800 } }
      }
      return {}
    })
    const tab = await test.workspace.acquire(executionInput())
    await tab.open('https://www.baidu.com/results', ['https://www.baidu.com'])
    await test.workspace.releaseExecution('e1')
    await test.workspace.acquireContinuation(tab.id, 'agent_run_raw_bytes')

    await expect(test.workspace.readAccessibilitySnapshot({
      tabId: tab.id, runId: 'agent_run_raw_bytes', expectedOrigin: 'https://www.baidu.com',
      expectedNavigationEpoch: tab.navigationEpoch, locators: [],
    })).rejects.toMatchObject({ code: 'ACTION_LIMIT_EXCEEDED' })
    expect(test.views[1]!.webContents.debugger.commands.some(({ method }) => (
      method === 'Page.getLayoutMetrics'
    ))).toBe(false)
  })

  it('rejects locator fan-out, hung CDP calls, and cancellation with stable safe errors', async () => {
    const fanout = createHarness((method) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame_main' } } }
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] }
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (method === 'DOM.querySelectorAll') return {
        nodeIds: Array.from({ length: MAX_BROWSER_INSPECTION_LOCATOR_MATCHES + 1 }, (_, index) => index + 1),
      }
      return {}
    })
    const fanoutTab = await fanout.workspace.acquire(executionInput())
    await fanoutTab.open('https://www.baidu.com/results', ['https://www.baidu.com'])
    await fanout.workspace.releaseExecution('e1')
    await fanout.workspace.acquireContinuation(fanoutTab.id, 'agent_run_1')
    await expect(fanout.workspace.readAccessibilitySnapshot({
      tabId: fanoutTab.id, runId: 'agent_run_1', expectedOrigin: 'https://www.baidu.com',
      expectedNavigationEpoch: fanoutTab.navigationEpoch, locators: ['css=main'],
    })).rejects.toMatchObject({ code: 'ACTION_LIMIT_EXCEEDED' })
    expect(fanout.views[1]!.webContents.debugger.commands.filter(({ method }) => (
      method === 'DOM.describeNode'
    ))).toHaveLength(0)

    const hung = createHarness((method) => method === 'Page.getFrameTree'
      ? new Promise(() => undefined)
      : {})
    const hungTab = await hung.workspace.acquire(executionInput())
    await hungTab.open('https://www.baidu.com/results', ['https://www.baidu.com'])
    await hung.workspace.releaseExecution('e1')
    await hung.workspace.acquireContinuation(hungTab.id, 'agent_run_hung')
    await expect(hung.workspace.readAccessibilitySnapshot({
      tabId: hungTab.id, runId: 'agent_run_hung', expectedOrigin: 'https://www.baidu.com',
      expectedNavigationEpoch: hungTab.navigationEpoch, locators: [], deadlineAt: Date.now() + 10,
    })).rejects.toMatchObject({ code: 'ACTION_LIMIT_EXCEEDED' })

    const controller = new AbortController()
    const pending = hung.workspace.readAccessibilitySnapshot({
      tabId: hungTab.id, runId: 'agent_run_hung', expectedOrigin: 'https://www.baidu.com',
      expectedNavigationEpoch: hungTab.navigationEpoch, locators: [], signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
  })

  it('enforces a shared finite CDP-call budget across locator resolution', async () => {
    const test = createHarness((method, params) => {
      const input = params as { nodeId?: number } | undefined
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame_main' } } }
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] }
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (method === 'DOM.querySelectorAll') return {
        nodeIds: Array.from({ length: MAX_BROWSER_INSPECTION_LOCATOR_MATCHES }, (_, index) => index + 1),
      }
      if (method === 'DOM.describeNode') return {
        node: { backendNodeId: input?.nodeId, nodeName: 'DIV', attributes: [] },
      }
      return {}
    })
    const tab = await test.workspace.acquire(executionInput())
    await tab.open('https://www.baidu.com/results', ['https://www.baidu.com'])
    await test.workspace.releaseExecution('e1')
    await test.workspace.acquireContinuation(tab.id, 'agent_run_budget')

    await expect(test.workspace.readAccessibilitySnapshot({
      tabId: tab.id, runId: 'agent_run_budget', expectedOrigin: 'https://www.baidu.com',
      expectedNavigationEpoch: tab.navigationEpoch,
      locators: Array.from({ length: 9 }, (_, index) => `css=.region-${index}`),
    })).rejects.toMatchObject({ code: 'ACTION_LIMIT_EXCEEDED' })
    expect(test.views[1]!.webContents.debugger.commands.filter(({ method }) => (
      method !== 'DOM.enable'
      && method !== 'Accessibility.enable'
      && method !== 'DOMStorage.enable'
    )).length).toBeLessThanOrEqual(2_048)
  })

  it.each([
    ['node resolution', 'Accessibility.getPartialAXTree'],
    ['box lookup', 'Page.getLayoutMetrics'],
    ['screenshot capture', 'Page.captureScreenshot'],
  ] as const)('rejects same-origin navigation racing %s', async (kind, navigationCommand) => {
    let navigate = false
    const respond = (method: string, params?: unknown) => {
      const input = params as { backendNodeId?: number } | undefined
      if (navigate && method === navigationCommand) {
        navigate = false
        const target = harness.views[1]!.webContents
        target.currentUrl = 'https://www.baidu.com/changed'
        target.emit('did-navigate', {}, target.currentUrl)
      }
      if (method === 'DOM.describeNode') return {
        node: { backendNodeId: input?.backendNodeId, nodeName: 'IMG', attributes: [] },
      }
      if (method === 'Accessibility.getPartialAXTree') return { nodes: [{
        nodeId: 'ax_image', backendDOMNodeId: input?.backendNodeId, frameId: 'frame_main', ignored: false,
        role: { value: 'img' }, name: { value: '结果图' },
      }] }
      if (method === 'DOM.getBoxModel') return {
        model: { content: [20, 30, 340, 30, 340, 230, 20, 230] },
      }
      if (method === 'Page.getLayoutMetrics') return {
        cssLayoutViewport: { clientWidth: 1200, clientHeight: 800 },
      }
      if (method === 'Page.captureScreenshot') return { data: 'stale-png-data' }
      return {}
    }
    const harness = createHarness(respond)
    const tab = await harness.workspace.acquire(executionInput())
    await tab.open('https://www.baidu.com/results', ['https://www.baidu.com'])
    await harness.workspace.releaseExecution('e1')
    await harness.workspace.acquireContinuation(tab.id, 'agent_run_1')
    const request = {
      tabId: tab.id, runId: 'agent_run_1', expectedOrigin: 'https://www.baidu.com',
      expectedNavigationEpoch: tab.navigationEpoch, backendNodeId: 11,
    }
    navigate = true

    const operation = kind === 'node resolution'
      ? harness.workspace.readNode(request)
      : kind === 'box lookup'
        ? harness.workspace.getContinuationNodeBox(request)
        : harness.workspace.captureContinuationNodeScreenshot({
          ...request,
          clip: { x: 20, y: 30, width: 320, height: 200 },
          expectedRole: 'img', expectedName: '结果图', expectedTagName: 'img',
        })

    await expect(operation).rejects.toMatchObject({ code: 'PAGE_CHANGED' })
  })

  it('notifies inspectors and rejects stale adapter reads after navigation and close', async () => {
    const { workspace, views } = createHarness((method) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame_main' } } }
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 1200, clientHeight: 800 } }
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] }
      return {}
    })
    const tab = await workspace.acquire(executionInput())
    await tab.open('https://www.baidu.com/detail', ['https://www.baidu.com'])
    await workspace.releaseExecution('e1')
    await workspace.acquireContinuation(tab.id, 'agent_run_1')
    const invalidated: string[] = []
    const unsubscribe = workspace.onPageInvalidated((tabId) => { invalidated.push(tabId) })
    const epoch = tab.navigationEpoch

    views[1]!.webContents.emit('did-start-navigation', { isMainFrame: true })
    expect(invalidated).toEqual([tab.id])
    views[1]!.webContents.emit('did-navigate', {}, 'https://www.baidu.com/next')

    expect(invalidated).toEqual([tab.id, tab.id])
    await expect(workspace.readAccessibilitySnapshot({
      tabId: tab.id, runId: 'agent_run_1', expectedOrigin: 'https://www.baidu.com',
      expectedNavigationEpoch: epoch, locators: [],
    })).rejects.toMatchObject({ code: 'PAGE_CHANGED' })

    await tab.close()
    expect(invalidated).toEqual([tab.id, tab.id, tab.id])
    unsubscribe()
  })

  it('uses a stable opaque persistent partition per AutoForge user', () => {
    expect(browserPartition('user_1')).toMatch(/^persist:autoforge-browser-[a-f0-9]{32}$/)
    expect(browserPartition('user_1')).toBe(browserPartition('user_1'))
    expect(browserPartition('user_2')).not.toBe(browserPartition('user_1'))
    expect(browserPartition('user_1')).not.toContain('user_1')
  })

  it('installs an allowed-origin session-storage bootstrap before target navigation', async () => {
    const order: string[] = []
    const store: BrowserSessionStorageStore = {
      get: vi.fn(async () => ({
        'https://fw.example': { PTOKEN: 'restored-private-token' },
        'https://evil.example': { PTOKEN: 'must-not-be-injected' },
      })),
      apply: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      drain: vi.fn(async () => undefined),
    }
    const harness = createHarness((method) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        order.push('bootstrap')
        return { identifier: 'session-bootstrap-1' }
      }
      return {}
    }, false, async (url) => {
      if (url.startsWith('https://')) order.push('navigate')
    })
    harness.workspace.setSessionStorageStore(store)
    const tab = await harness.workspace.acquire(executionInput())

    await tab.open('https://fw.example/start', [
      'https://fw.example',
      'https://portal.example',
    ])

    expect(order).toEqual(['bootstrap', 'navigate'])
    expect(store.get).toHaveBeenCalledWith('user_1', [
      'https://fw.example',
      'https://portal.example',
    ])
    const bootstrap = harness.views[1]!.webContents.debugger.commands.find(
      ({ method }) => method === 'Page.addScriptToEvaluateOnNewDocument',
    )?.params as { source?: string } | undefined
    expect(bootstrap?.source).toContain('restored-private-token')
    expect(bootstrap?.source).not.toContain('must-not-be-injected')
  })

  it('persists only HTTPS session-storage CDP mutations and stops observing closed tabs', async () => {
    const store: BrowserSessionStorageStore = {
      get: vi.fn(async () => ({})),
      apply: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      drain: vi.fn(async () => undefined),
    }
    const harness = createHarness((method) => (
      method === 'Page.addScriptToEvaluateOnNewDocument'
        ? { identifier: 'session-bootstrap-1' }
        : {}
    ))
    harness.workspace.setSessionStorageStore(store)
    const tab = await harness.workspace.acquire(executionInput())
    const targetDebugger = harness.views[1]!.webContents.debugger
    const emitMutation = (method: string, params: Record<string, unknown>) => {
      targetDebugger.emit('message', {}, method, params)
    }

    emitMutation('DOMStorage.domStorageItemAdded', {
      storageId: { securityOrigin: 'https://fw.example', isLocalStorage: false },
      key: 'PTOKEN', newValue: 'persisted-private-token',
    })
    emitMutation('DOMStorage.domStorageItemUpdated', {
      storageId: { securityOrigin: 'https://fw.example', isLocalStorage: false },
      key: 'PTOKEN', newValue: 'rotated-private-token', oldValue: 'persisted-private-token',
    })
    emitMutation('DOMStorage.domStorageItemRemoved', {
      storageId: { securityOrigin: 'https://fw.example', isLocalStorage: false },
      key: 'checkState',
    })
    emitMutation('DOMStorage.domStorageItemsCleared', {
      storageId: { securityOrigin: 'https://portal.example', isLocalStorage: false },
    })
    emitMutation('DOMStorage.domStorageItemAdded', {
      storageId: { securityOrigin: 'https://fw.example', isLocalStorage: true },
      key: 'local', newValue: 'ignored-local-storage',
    })
    emitMutation('DOMStorage.domStorageItemAdded', {
      storageId: { securityOrigin: 'http://unsafe.example', isLocalStorage: false },
      key: 'unsafe', newValue: 'ignored-insecure-storage',
    })

    await vi.waitFor(() => expect(store.apply).toHaveBeenCalledTimes(4))
    expect(store.apply).toHaveBeenNthCalledWith(1, 'user_1', {
      type: 'set', origin: 'https://fw.example', key: 'PTOKEN', value: 'persisted-private-token',
    })
    expect(store.apply).toHaveBeenNthCalledWith(2, 'user_1', {
      type: 'set', origin: 'https://fw.example', key: 'PTOKEN', value: 'rotated-private-token',
    })
    expect(store.apply).toHaveBeenNthCalledWith(3, 'user_1', {
      type: 'remove', origin: 'https://fw.example', key: 'checkState',
    })
    expect(store.apply).toHaveBeenNthCalledWith(4, 'user_1', {
      type: 'clear', origin: 'https://portal.example',
    })

    await tab.close()
    emitMutation('DOMStorage.domStorageItemAdded', {
      storageId: { securityOrigin: 'https://fw.example', isLocalStorage: false },
      key: 'late', newValue: 'must-not-persist',
    })
    await Promise.resolve()
    expect(store.apply).toHaveBeenCalledTimes(4)
  })

  it('drains encrypted session-storage writes before workspace shutdown completes', async () => {
    let releaseDrain!: () => void
    const draining = new Promise<void>((resolve) => { releaseDrain = resolve })
    const store: BrowserSessionStorageStore = {
      get: vi.fn(async () => ({})),
      apply: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      drain: vi.fn(() => draining),
    }
    const harness = createHarness()
    harness.workspace.setSessionStorageStore(store)
    await harness.workspace.acquire(executionInput())

    let completed = false
    const shutdown = harness.workspace.shutdown().then(() => { completed = true })
    await vi.waitFor(() => expect(store.drain).toHaveBeenCalledOnce())
    expect(completed).toBe(false)

    releaseDrain()
    await shutdown
    expect(completed).toBe(true)
  })

  it('shuts down cleanly when Electron clears the view webContents before destroyed handlers run', async () => {
    const harness = createHarness()
    await harness.workspace.acquire(executionInput())
    const view = harness.views[1]!
    const contents = view.webContents
    expect(contents.debugger.listenerCount('message')).toBe(1)
    contents.prependOnceListener('destroyed', () => {
      Object.defineProperty(view, 'webContents', {
        configurable: true,
        get: () => undefined,
      })
    })

    await expect(harness.workspace.shutdown()).resolves.toBeUndefined()

    expect(contents.debugger.listenerCount('message')).toBe(0)
  })

  it('creates one BaseWindow and secure switchable target tabs sharing only the same user session', async () => {
    const { workspace, views, windows, backgroundColor } = createHarness()
    const first = await workspace.acquire(executionInput({ executionId: 'exec_1' }))
    await workspace.releaseExecution('exec_1')
    const reused = await workspace.acquire(executionInput({ executionId: 'exec_2', chatRunId: 'chat_run_2' }))
    const secondWorkflow = await workspace.acquire(executionInput({
      executionId: 'exec_3', chatRunId: 'chat_run_3', workflowId: 'workflow.two',
    }))
    const secondUser = await workspace.acquire(executionInput({
      executionId: 'exec_4', chatRunId: 'chat_run_4', userId: 'user_2',
    }))

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
    const targetPreferences = [views[1], views[3], views[4]]
      .map((view) => view!.options.webPreferences)
    expect(targetPreferences[0]).toMatchObject({
      partition: browserPartition('user_1'), nodeIntegration: false, contextIsolation: true,
      sandbox: true, webSecurity: true, webviewTag: false, allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
    })
    expect(targetPreferences[1]).toMatchObject({ partition: browserPartition('user_1') })
    expect(targetPreferences[2]).toMatchObject({ partition: browserPartition('user_2') })
    expect(windows[0]!.children).toHaveLength(2)
  })

  it('does not reuse across exact provenance changes or silently upgrade an unclaimed tab', async () => {
    const { workspace } = createHarness()
    const legacy = await acquire(workspace, 'legacy_execution')
    await workspace.releaseExecution('legacy_execution')
    const first = await workspace.acquire(executionInput())
    await workspace.releaseExecution('e1')
    const same = await workspace.acquire(executionInput({ executionId: 'e2', chatRunId: 'chat_run_2' }))
    await workspace.releaseExecution('e2')
    const otherConversation = await workspace.acquire(executionInput({
      executionId: 'e3', chatRunId: 'chat_run_3', conversationId: 'conversation_2',
    }))
    const otherFingerprint = await workspace.acquire(executionInput({
      executionId: 'e4', chatRunId: 'chat_run_4', securityFingerprint: 'b'.repeat(64),
    }))
    const otherMatrix = await workspace.acquire(executionInput({
      executionId: 'e5', chatRunId: 'chat_run_5',
      permissionMatrix: { 'browser.open': ['https://example.com/*'] },
    }))
    const otherPolicy = await workspace.acquire(executionInput({
      executionId: 'e6', chatRunId: 'chat_run_6',
      browserContinuation: { readableRegions: ['css=article'] },
    }))
    const otherVersion = await workspace.acquire(executionInput({
      executionId: 'e7', chatRunId: 'chat_run_7', workflowVersion: '2.0.0',
    }))
    const development = await workspace.acquire(executionInput({
      executionId: 'e8', chatRunId: 'chat_run_8', source: 'development', buildHash: 'c'.repeat(64),
    }))
    await workspace.releaseExecution('e8')
    const otherBuild = await workspace.acquire(executionInput({
      executionId: 'e9', chatRunId: 'chat_run_9', source: 'development', buildHash: 'd'.repeat(64),
    }))

    expect(same.id).toBe(first.id)
    expect(new Set([
      legacy.id, first.id, otherConversation.id, otherFingerprint.id, otherMatrix.id, otherPolicy.id,
      otherVersion.id, development.id, otherBuild.id,
    ]).size).toBe(9)
  })

  it('keeps workflow and continuation ownership exclusive and releases takeover synchronously', async () => {
    const { workspace } = createHarness()
    const tab = await workspace.acquire(executionInput())
    const registry = continuationRegistry(workspace)
    workspace.setContinuationRegistry(registry)
    const binding = registry.bind({ ...executionInput(), tabId: tab.id } as BrowserContinuationBindingInput)

    await expect(registry.acquire(binding.bindingId, {
      userId: 'user_1', conversationId: 'conversation_1', runId: 'run_2',
    })).rejects.toMatchObject({ code: 'PAGE_BUSY' })
    await workspace.releaseExecution('e1')
    const lease = await registry.acquire(binding.bindingId, {
      userId: 'user_1', conversationId: 'conversation_1', runId: 'run_2',
    })
    await expect(registry.acquire(binding.bindingId, {
      userId: 'user_1', conversationId: 'conversation_1', runId: 'run_3',
    })).rejects.toMatchObject({ code: 'PAGE_BUSY' })

    await lease.release()
    const replacement = await registry.acquire(binding.bindingId, {
      userId: 'user_1', conversationId: 'conversation_1', runId: 'run_3',
    })

    expect(replacement.ownerRunId).toBe('run_3')
    await replacement.release()
  })

  it('preloads one detached input shield before a continuation-capable target acquisition returns', async () => {
    const { workspace, views, windows } = createHarness()

    await workspace.acquire(executionInput())

    const [toolbar, target, shield] = views
    expect(views).toHaveLength(3)
    expect(shield!.webContents.loaded).toHaveLength(1)
    expect(shield!.webContents.destroyed).toBe(false)
    expect(windows[0]!.children).toContain(toolbar)
    expect(windows[0]!.children).toContain(target)
    expect(windows[0]!.children).not.toContain(shield)
  })

  it('does not create an input shield for an ordinary non-continuation target', async () => {
    const { workspace, views, windows } = createHarness()

    await acquire(workspace, 'exec_ordinary')

    expect(views).toHaveLength(2)
    expect(windows[0]!.children).toEqual([views[0], views[1]])
  })

  it('closes an unpublished continuation target when its input shield fails to load', async () => {
    const { workspace, views, windows } = createHarness(
      () => ({}), false,
      async (url) => {
        if (url.startsWith('data:text/html')
          && decodeURIComponent(url).includes('<body aria-hidden="true">')) {
          throw new Error('shield document failed to load')
        }
      },
    )

    await expect(workspace.acquire(executionInput())).rejects.toThrow('shield document failed to load')

    const [, target, shield] = views
    expect(views).toHaveLength(3)
    expect(target!.webContents.destroyed).toBe(true)
    expect(shield!.webContents.destroyed).toBe(true)
    expect(windows[0]!.children).not.toContain(target)
    expect(windows[0]!.children).not.toContain(shield)
  })

  it.each(['read', 'screenshot'] as const)(
    'keeps a pending continuation %s running below the dedicated input shield',
    async (operation) => {
      const gate = deferred<unknown>()
      const respond = (method: string, params?: unknown) => {
        const input = params as { backendNodeId?: number } | undefined
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame_main' } } }
        if (method === 'Accessibility.getFullAXTree') return operation === 'read' ? gate.promise : { nodes: [] }
        if (method === 'DOM.describeNode') return {
          node: { backendNodeId: input?.backendNodeId, nodeName: 'IMG', attributes: [] },
        }
        if (method === 'Accessibility.getPartialAXTree') return { nodes: [{
          nodeId: 'ax_image', backendDOMNodeId: input?.backendNodeId, frameId: 'frame_main', ignored: false,
          role: { value: 'img' }, name: { value: '结果图' },
        }] }
        if (method === 'DOM.getBoxModel') return {
          model: { content: [20, 30, 340, 30, 340, 230, 20, 230] },
        }
        if (method === 'Page.getLayoutMetrics') return {
          cssLayoutViewport: { clientWidth: 1200, clientHeight: 800 },
        }
        if (method === 'Page.captureScreenshot') return gate.promise
        return {}
      }
      const { workspace, views, windows } = createHarness(respond)
      const input = executionInput()
      const tab = await workspace.acquire(input)
      await tab.open('https://www.baidu.com/results', ['https://www.baidu.com'])
      const registry = continuationRegistry(workspace)
      workspace.setContinuationRegistry(registry)
      const binding = registry.bind({ ...input, tabId: tab.id } as BrowserContinuationBindingInput)
      await workspace.releaseExecution(input.executionId)
      const lease = await registry.acquire(binding.bindingId, {
        userId: input.userId, conversationId: input.conversationId!, runId: 'run_reading',
      })
      const invalidated = vi.fn()
      workspace.onPageInvalidated(invalidated)
      const request = {
        tabId: tab.id, runId: 'run_reading', expectedOrigin: 'https://www.baidu.com',
        expectedNavigationEpoch: tab.navigationEpoch,
      }
      const pending = operation === 'read'
        ? workspace.readAccessibilitySnapshot({ ...request, locators: [] })
        : workspace.captureContinuationNodeScreenshot({
          ...request, backendNodeId: 11,
          clip: { x: 20, y: 30, width: 320, height: 200 },
          expectedRole: 'img', expectedName: '结果图', expectedTagName: 'img',
        })
      await vi.waitFor(() => expect(views[1]!.webContents.debugger.commands)
        .toContainEqual(expect.objectContaining({
          method: operation === 'read' ? 'Accessibility.getFullAXTree' : 'Page.captureScreenshot',
        })))

      const [toolbar, target, shield] = views
      expect(invalidated).not.toHaveBeenCalled()
      expect(lease.isCurrent(binding)).toBe(true)
      expect(windows[0]!.children).toEqual([target, shield, toolbar])
      expect(toolbar!.bounds.at(-1)).toEqual({ x: 0, y: 0, width: 1200, height: 52 })
      expect(shield!.bounds.at(-1)).toEqual({ x: 0, y: 52, width: 1200, height: 748 })
      gate.resolve(operation === 'read' ? { nodes: [] } : { data: 'stale-png-data' })

      if (operation === 'read') await expect(pending).resolves.toMatchObject({ tabId: tab.id })
      else await expect(pending).resolves.toBe('stale-png-data')
      await lease.release()
    },
  )

  it('attaches a dedicated native input shield for the full continuation lease', async () => {
    const harness = createHarness()
    const { views, windows } = harness
    const { binding, registry } = await bindIdleContinuation(harness)

    const lease = await registry.acquire(binding.bindingId, {
      userId: 'user_1', conversationId: 'conversation_1', runId: 'run_shielded',
    })

    const [toolbar, target, shield] = views
    expect(shield).toBeDefined()
    expect(shield).not.toBe(toolbar)
    expect(shield).not.toBe(target)
    expect(shield?.bounds.at(-1)).toEqual({ x: 0, y: 52, width: 1200, height: 748 })
    expect(shield?.backgroundColors).toContain('rgba(0, 0, 0, 0.004)')
    expect(shield?.options.webPreferences).toMatchObject({
      partition: 'autoforge-browser-toolbar',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    })
    expect(shield?.webContents.windowOpenHandler?.({ url: 'https://attacker.example/' }))
      .toEqual({ action: 'deny' })
    const shieldNavigation = { preventDefault: vi.fn() }
    shield?.webContents.emit('will-navigate', shieldNavigation, 'https://attacker.example/')
    expect(shieldNavigation.preventDefault).toHaveBeenCalledOnce()
    expect(windows[0]?.children).toEqual([target, shield, toolbar])
    expect(lease.isCurrent(binding)).toBe(true)
    expect(toolbar?.bounds.at(-1)).toEqual({ x: 0, y: 0, width: 1200, height: 52 })
    const toolbarHtml = decodeURIComponent(toolbar!.webContents.loaded.at(-1)!.split(',')[1]!)
    const shieldHtml = decodeURIComponent(shield!.webContents.loaded[0]!.split(',')[1]!)
    expect(toolbarHtml).not.toContain('data-autoforge-input-shield')
    expect(shieldHtml).toContain('rgb(0 0 0 / 0.004)')
    expect(shieldHtml).toContain('class="ai-operation-banner"')
    expect(shieldHtml).toContain('AI 正在操作此网页')
    expect(shieldHtml).toContain('操作完成后可继续使用')
    await lease.release()
  })

  it('keeps a suspended continuation reserved while restoring physical user input', async () => {
    const harness = createHarness()
    const { workspace, views, windows } = harness
    const { binding, registry } = await bindIdleContinuation(harness)
    const lease = await registry.acquire(binding.bindingId, {
      userId: 'user_1', conversationId: 'conversation_1', runId: 'run_suspended',
    })
    const [toolbar, target, shield] = views
    target!.webContents.currentUrl = 'https://www.baidu.com/login'
    target!.webContents.emit('did-navigate', {}, target!.webContents.currentUrl)
    expect(windows[0]!.children).toEqual([target, shield, toolbar])

    await workspace.suspendContinuation(binding.tabId, 'run_suspended')

    expect(lease.isCurrent(binding)).toBe(true)
    expect(windows[0]!.children).toEqual([target, toolbar])
    const pointer = { preventDefault: vi.fn() }
    const keyboard = { preventDefault: vi.fn() }
    target!.webContents.emit('before-mouse-event', pointer, { type: 'mouseDown' })
    target!.webContents.emit('before-input-event', keyboard, { type: 'keyDown', key: 'A' })
    expect(pointer.preventDefault).not.toHaveBeenCalled()
    expect(keyboard.preventDefault).not.toHaveBeenCalled()
    await expect(workspace.acquireContinuation(binding.tabId, 'run_competing'))
      .rejects.toMatchObject({ code: 'PAGE_BUSY' })

    const current = await workspace.getContinuationState(binding.tabId, 'run_suspended')
    await workspace.resumeContinuation(binding.tabId, 'run_suspended', current)

    expect(windows[0]!.children).toEqual([target, shield, toolbar])
    const resumedKeyboard = { preventDefault: vi.fn() }
    target!.webContents.emit('before-input-event', resumedKeyboard, { type: 'keyDown', key: 'B' })
    expect(resumedKeyboard.preventDefault).toHaveBeenCalledOnce()
    await lease.release()
    expect(windows[0]!.children).toEqual([target, toolbar])
  })

  it('observes only suspended physical input and page activity', async () => {
    let targetContents: FakeWebContents | undefined
    const harness = createHarness((method) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (method === 'Accessibility.queryAXTree') {
        return {
          nodes: [{
            backendDOMNodeId: 80, ignored: false,
            role: { value: 'button' }, name: { value: '继续' },
          }],
        }
      }
      if (method === 'DOM.getBoxModel') {
        return { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } }
      }
      if (method === 'Input.dispatchMouseEvent') {
        targetContents?.emit(
          'before-mouse-event',
          { preventDefault: vi.fn() },
          { type: 'mouseDown' },
        )
      }
      return {}
    })
    const { workspace, views } = harness
    const { tab, binding, registry } = await bindIdleContinuation(harness)
    const lease = await registry.acquire(binding.bindingId, {
      userId: 'user_1', conversationId: 'conversation_1', runId: 'run_activity',
    })
    targetContents = views[1]!.webContents
    targetContents.currentUrl = 'https://www.baidu.com/login'
    const activities: Array<{ kind: string }> = []
    const unsubscribe = workspace.onContinuationActivity((activity) => { activities.push(activity) })
    await workspace.suspendContinuation(binding.tabId, 'run_activity')

    targetContents.emit(
      'before-mouse-event',
      { preventDefault: vi.fn() },
      { type: 'mouseMove' },
    )
    targetContents.emit(
      'before-mouse-event',
      { preventDefault: vi.fn() },
      { type: 'mouseDown' },
    )
    targetContents.emit(
      'before-input-event',
      { preventDefault: vi.fn() },
      { type: 'keyDown', key: 'A' },
    )
    targetContents.emit('did-navigate', {}, targetContents.currentUrl)

    expect(activities.map(({ kind }) => kind)).toEqual([
      'physical_input',
      'physical_input',
      'page_change',
    ])
    const suspendedPage = await workspace.getContinuationState(binding.tabId, 'run_activity')
    expect(suspendedPage.activityRevision).toBe(3)

    await workspace.resumeContinuation(binding.tabId, 'run_activity', suspendedPage)
    await tab.click('role=button[name="继续"]', 'https://www.baidu.com')
    expect(activities).toHaveLength(3)

    unsubscribe()
    await lease.release()
  })

  it('keeps promotion suspended when activity changes while the input shield loads', async () => {
    const shieldLoad = deferred<void>()
    let shieldLoads = 0
    const harness = createHarness(
      () => ({}), false,
      async (url) => {
        if (url.startsWith('data:text/html')
          && decodeURIComponent(url).includes('<body aria-hidden="true">')
          && ++shieldLoads === 2) {
          await shieldLoad.promise
        }
      },
    )
    const { workspace, views, windows } = harness
    const { binding, registry } = await bindIdleContinuation(harness)
    const lease = await registry.acquire(binding.bindingId, {
      userId: 'user_1', conversationId: 'conversation_1', runId: 'run_promoting',
    })
    const [toolbar, target, shield] = views
    target!.webContents.currentUrl = 'https://www.baidu.com/login'
    await workspace.suspendContinuation(binding.tabId, 'run_promoting')
    const expectedPage = await workspace.getContinuationState(binding.tabId, 'run_promoting')
    shield!.webContents.close()

    const promotion = workspace.resumeContinuation(binding.tabId, 'run_promoting', expectedPage)
    await vi.waitFor(() => expect(views).toHaveLength(4))
    target!.webContents.emit(
      'before-mouse-event',
      { preventDefault: vi.fn() },
      { type: 'mouseDown' },
    )
    shieldLoad.resolve()

    await expect(promotion).rejects.toMatchObject({ code: 'PAGE_CHANGED' })
    expect(lease.isCurrent(binding)).toBe(true)
    expect(windows[0]!.children).toEqual([target, toolbar])
    const suspendedInput = { preventDefault: vi.fn() }
    target!.webContents.emit('before-input-event', suspendedInput, { type: 'keyDown', key: 'A' })
    expect(suspendedInput.preventDefault).not.toHaveBeenCalled()
    await lease.release()
  })

  it('keeps promotion suspended when only the URL changes while the input shield loads', async () => {
    const shieldLoad = deferred<void>()
    let shieldLoads = 0
    const harness = createHarness(
      () => ({}), false,
      async (url) => {
        if (url.startsWith('data:text/html')
          && decodeURIComponent(url).includes('<body aria-hidden="true">')
          && ++shieldLoads === 2) {
          await shieldLoad.promise
        }
      },
    )
    const { workspace, views, windows } = harness
    const { binding, registry } = await bindIdleContinuation(harness)
    const lease = await registry.acquire(binding.bindingId, {
      userId: 'user_1', conversationId: 'conversation_1', runId: 'run_url_promoting',
    })
    const [toolbar, target, shield] = views
    target!.webContents.currentUrl = 'https://www.baidu.com/login'
    await workspace.suspendContinuation(binding.tabId, 'run_url_promoting')
    const expectedPage = await workspace.getContinuationState(binding.tabId, 'run_url_promoting')
    shield!.webContents.close()

    const promotion = workspace.resumeContinuation(binding.tabId, 'run_url_promoting', expectedPage)
    await vi.waitFor(() => expect(views).toHaveLength(4))
    target!.webContents.currentUrl = 'https://www.baidu.com/dashboard'
    shieldLoad.resolve()

    await expect(promotion).rejects.toMatchObject({ code: 'PAGE_CHANGED' })
    expect(lease.isCurrent(binding)).toBe(true)
    expect(windows[0]!.children).toEqual([target, toolbar])
    const suspendedInput = { preventDefault: vi.fn() }
    target!.webContents.emit('before-input-event', suspendedInput, { type: 'keyDown', key: 'A' })
    expect(suspendedInput.preventDefault).not.toHaveBeenCalled()
    await lease.release()
  })

  it('keeps a continuation suspended when its authenticated page changes before resume', async () => {
    const harness = createHarness()
    const { workspace, views, windows } = harness
    const { binding, registry } = await bindIdleContinuation(harness)
    const [, target] = views
    target!.webContents.currentUrl = 'https://www.baidu.com/login'
    target!.webContents.emit('did-navigate', {}, target!.webContents.currentUrl)
    const lease = await registry.acquire(binding.bindingId, {
      userId: 'user_1', conversationId: 'conversation_1', runId: 'run_redirecting',
    })
    await workspace.suspendContinuation(binding.tabId, 'run_redirecting')
    const authenticated = await workspace.getContinuationState(binding.tabId, 'run_redirecting')

    target!.webContents.currentUrl = 'https://www.baidu.com/login/callback'
    target!.webContents.emit('did-navigate', {}, target!.webContents.currentUrl)
    await expect(workspace.resumeContinuation(binding.tabId, 'run_redirecting', authenticated))
      .rejects.toMatchObject({ code: 'PAGE_CHANGED' })

    expect(windows[0]!.children).toEqual([target, views[0]])
    const redirected = await workspace.getContinuationState(binding.tabId, 'run_redirecting')
    await workspace.resumeContinuation(binding.tabId, 'run_redirecting', redirected)
    expect(windows[0]!.children).toEqual([target, views[2], views[0]])
    await lease.release()
  })

  it('keeps the owned shield attached and below the full-height toolbar while loading repaint is pending', async () => {
    const toolbarLoad = deferred<void>()
    let pauseToolbar = false
    let toolbarPaused = false
    const harness = createHarness(
      () => ({}), false,
      async (url) => {
        if (pauseToolbar && url.startsWith('data:text/html')
          && !decodeURIComponent(url).includes('<body aria-hidden="true">')) {
          toolbarPaused = true
          await toolbarLoad.promise
        }
      },
    )
    const { views, windows } = harness
    const { binding, registry } = await bindIdleContinuation(harness)
    const lease = await registry.acquire(binding.bindingId, {
      userId: 'user_1', conversationId: 'conversation_1', runId: 'run_loading',
    })
    const [toolbar, target, shield] = views
    const removeChildView = vi.spyOn(windows[0]!.contentView, 'removeChildView')
    pauseToolbar = true

    target!.webContents.emit('did-start-loading')
    await vi.waitFor(() => expect(toolbarPaused).toBe(true))

    expect(removeChildView).not.toHaveBeenCalledWith(shield)
    expect(windows[0]!.children).toEqual([target, shield, toolbar])
    expect(target!.bounds.at(-1)).toEqual({ x: 0, y: 52, width: 1200, height: 748 })
    expect(shield!.bounds.at(-1)).toEqual({ x: 0, y: 52, width: 1200, height: 748 })
    expect(toolbar!.bounds.at(-1)).toEqual({ x: 0, y: 0, width: 1200, height: 800 })

    toolbarLoad.resolve()
    target!.webContents.emit('did-stop-loading')
    await lease.release()
  })

  it('keeps the owned shield attached and below the full-height toolbar while blocked repaint is pending', async () => {
    const toolbarLoad = deferred<void>()
    let pauseToolbar = false
    let toolbarPaused = false
    const harness = createHarness(
      () => ({}), false,
      async (url) => {
        if (pauseToolbar && url.startsWith('data:text/html')
          && !decodeURIComponent(url).includes('<body aria-hidden="true">')) {
          toolbarPaused = true
          await toolbarLoad.promise
        }
      },
    )
    const { views, windows } = harness
    const { binding, registry } = await bindIdleContinuation(harness)
    const lease = await registry.acquire(binding.bindingId, {
      userId: 'user_1', conversationId: 'conversation_1', runId: 'run_blocked',
    })
    const [toolbar, target, shield] = views
    const removeChildView = vi.spyOn(windows[0]!.contentView, 'removeChildView')
    pauseToolbar = true

    target!.webContents.windowOpenHandler?.({ url: 'https://attacker.example/' })
    await vi.waitFor(() => expect(toolbarPaused).toBe(true))

    expect(removeChildView).not.toHaveBeenCalledWith(shield)
    expect(windows[0]!.children).toEqual([target, shield, toolbar])
    expect(target!.bounds.at(-1)).toEqual({ x: 0, y: 52, width: 1200, height: 748 })
    expect(shield!.bounds.at(-1)).toEqual({ x: 0, y: 52, width: 1200, height: 748 })
    expect(toolbar!.bounds.at(-1)).toEqual({ x: 0, y: 0, width: 1200, height: 800 })

    toolbarLoad.resolve()
    await lease.release()
  })

  it.each(['render-process-gone', 'destroyed'] as const)(
    'fails closed for every continuation owner when the exact shield emits %s',
    async (event) => {
      const gate = deferred<unknown>()
      const harness = createHarness((method) => ({
        'DOM.getDocument': { root: { nodeId: 1 } },
        'Accessibility.queryAXTree': {
          nodes: [{ backendDOMNodeId: 80, ignored: false, role: { value: 'button' }, name: { value: '继续' } }],
        },
        'DOM.getBoxModel': { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } },
      } as Record<string, unknown>)[method]
        ?? (method === 'Input.dispatchMouseEvent' ? gate.promise : {}))
      const { workspace, views, windows } = harness
      const firstInput = executionInput()
      const firstTab = await workspace.acquire(firstInput)
      await workspace.releaseExecution(firstInput.executionId)
      const secondInput = executionInput({
        executionId: 'e2', chatRunId: 'chat_run_2', workflowId: 'workflow.two',
      })
      const secondTab = await workspace.acquire(secondInput)
      await secondTab.open('https://www.baidu.com/results', ['https://www.baidu.com'])
      const registry = continuationRegistry(workspace)
      workspace.setContinuationRegistry(registry)
      const firstBinding = registry.bind({
        ...firstInput, tabId: firstTab.id,
      } as BrowserContinuationBindingInput)
      const secondBinding = registry.bind({
        ...secondInput, tabId: secondTab.id,
      } as BrowserContinuationBindingInput)
      workspace.markContinuationBound(firstTab.id)
      workspace.markContinuationBound(secondTab.id)
      await workspace.releaseExecution(secondInput.executionId)
      const firstLease = await registry.acquire(firstBinding.bindingId, {
        userId: firstInput.userId, conversationId: firstInput.conversationId!, runId: 'run_first',
      })
      const secondLease = await registry.acquire(secondBinding.bindingId, {
        userId: secondInput.userId, conversationId: secondInput.conversationId!, runId: 'run_second',
      })
      const pending = secondTab.click('role=button[name="继续"]', 'https://www.baidu.com')
      await vi.waitFor(() => expect(views[3]!.webContents.debugger.commands)
        .toContainEqual(expect.objectContaining({ method: 'Input.dispatchMouseEvent' })))
      const [toolbar, , shield, activeTarget] = views
      expect(windows[0]!.children).toEqual([activeTarget, shield, toolbar])

      if (event === 'render-process-gone') {
        shield!.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
      } else {
        shield!.webContents.close()
      }
      shield!.webContents.emit('destroyed')
      const childrenAfterLoss = [...windows[0]!.children]
      const leaseStateAfterLoss = [
        firstLease.isCurrent(firstBinding), secondLease.isCurrent(secondBinding),
      ]
      const liveBindingsAfterLoss = [
        registry.get(firstBinding.bindingId), registry.get(secondBinding.bindingId),
      ]
      const terminalEventsAfterLoss = [...registry.terminalEvents]
      gate.resolve({})

      await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
      expect(childrenAfterLoss).toEqual([activeTarget, toolbar])
      expect(shield!.webContents.destroyed).toBe(true)
      expect(leaseStateAfterLoss).toEqual([false, false])
      expect(liveBindingsAfterLoss).toEqual([undefined, undefined])
      expect(terminalEventsAfterLoss).toHaveLength(2)
      expect(terminalEventsAfterLoss).toEqual(expect.arrayContaining([
        expect.objectContaining({
          bindingId: firstBinding.bindingId,
          value: expect.objectContaining({ status: 'closed', terminalReason: 'PAGE_CLOSED' }),
        }),
        expect.objectContaining({
          bindingId: secondBinding.bindingId,
          value: expect.objectContaining({ status: 'closed', terminalReason: 'PAGE_CLOSED' }),
        }),
      ]))
      await firstLease.release()
      await secondLease.release()
    },
  )

  it('does not add a false shield terminal event during intentional workspace teardown', async () => {
    const harness = createHarness()
    const { workspace } = harness
    const { binding, registry } = await bindIdleContinuation(harness)
    const lease = await registry.acquire(binding.bindingId, {
      userId: 'user_1', conversationId: 'conversation_1', runId: 'run_reset',
    })

    await workspace.reset()

    expect(lease.isCurrent(binding)).toBe(false)
    expect(registry.terminalEvents).toHaveLength(1)
    expect(registry.terminalEvents[0]).toMatchObject({
      bindingId: binding.bindingId,
      value: { status: 'closed', terminalReason: 'PAGE_CLOSED' },
    })
    await lease.release()
  })

  it('rebuilds an idle destroyed shield and ignores stale shield lifecycle events', async () => {
    const harness = createHarness()
    const { views, windows } = harness
    const { binding, registry } = await bindIdleContinuation(harness)
    const [toolbar, target, staleShield] = views

    staleShield!.webContents.close()
    expect(registry.get(binding.bindingId)).toBe(binding)
    expect(registry.terminalEvents).toEqual([])

    const lease = await registry.acquire(binding.bindingId, {
      userId: 'user_1', conversationId: 'conversation_1', runId: 'run_rebuilt',
    })
    const replacementShield = views[3]!
    expect(views).toHaveLength(4)
    expect(windows[0]!.children).toEqual([target, replacementShield, toolbar])

    staleShield!.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    staleShield!.webContents.emit('destroyed')

    expect(lease.isCurrent(binding)).toBe(true)
    expect(registry.terminalEvents).toEqual([])
    expect(windows[0]!.children).toEqual([target, replacementShield, toolbar])
    await lease.release()
  })

  it('swallows shield and leaked target input without cancelling pending CDP work', async () => {
    const dispatched = deferred<unknown>()
    const respond = (method: string) => ({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'Accessibility.queryAXTree': {
        nodes: [{ backendDOMNodeId: 80, ignored: false, role: { value: 'button' }, name: { value: '继续' } }],
      },
      'DOM.getBoxModel': { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } },
    } as Record<string, unknown>)[method]
      ?? (method === 'Input.dispatchMouseEvent' ? dispatched.promise : {})
    const { workspace, views } = createHarness(respond)
    const input = executionInput()
    const tab = await workspace.acquire(input)
    await tab.open('https://www.baidu.com/start', ['https://www.baidu.com'])
    const registry = continuationRegistry(workspace)
    workspace.setContinuationRegistry(registry)
    const binding = registry.bind({ ...input, tabId: tab.id } as BrowserContinuationBindingInput)
    await workspace.releaseExecution(input.executionId)
    const lease = await registry.acquire(binding.bindingId, {
      userId: input.userId, conversationId: input.conversationId!, runId: 'run_clicking',
    })
    const [, target, shield] = views
    expect(shield).toBeDefined()
    const invalidated = vi.fn()
    workspace.onPageInvalidated(invalidated)
    const targetPointer = vi.fn()
    const targetKeyboard = vi.fn()
    target!.webContents.on('before-mouse-event', targetPointer)
    target!.webContents.on('before-input-event', targetKeyboard)

    const clicking = tab.click('role=button[name="继续"]', 'https://www.baidu.com')
    await vi.waitFor(() => expect(target!.webContents.debugger.commands)
      .toContainEqual(expect.objectContaining({ method: 'Input.dispatchMouseEvent' })))
    const shieldPointer = { preventDefault: vi.fn() }
    const shieldKeyboard = { preventDefault: vi.fn() }
    shield!.webContents.emit('before-mouse-event', shieldPointer, { type: 'mouseDown' })
    shield!.webContents.emit('before-input-event', shieldKeyboard, { type: 'keyDown', key: 'A' })

    expect(shieldPointer.preventDefault).toHaveBeenCalledOnce()
    expect(shieldKeyboard.preventDefault).toHaveBeenCalledOnce()
    expect(targetPointer).not.toHaveBeenCalled()
    expect(targetKeyboard).not.toHaveBeenCalled()
    expect(invalidated).not.toHaveBeenCalled()
    expect(lease.isCurrent(binding)).toBe(true)

    const syntheticPointer = { preventDefault: vi.fn() }
    target!.webContents.emit('before-mouse-event', syntheticPointer, { type: 'mouseDown' })
    expect(syntheticPointer.preventDefault).not.toHaveBeenCalled()

    dispatched.resolve({})
    await expect(clicking).resolves.toBeUndefined()

    const leakedPointer = { preventDefault: vi.fn() }
    const leakedKeyboard = { preventDefault: vi.fn() }
    target!.webContents.emit('before-mouse-event', leakedPointer, { type: 'mouseDown' })
    target!.webContents.emit('before-input-event', leakedKeyboard, { type: 'keyDown', key: 'A' })
    expect(leakedPointer.preventDefault).toHaveBeenCalledOnce()
    expect(leakedKeyboard.preventDefault).toHaveBeenCalledOnce()
    expect(invalidated).not.toHaveBeenCalled()
    expect(lease.isCurrent(binding)).toBe(true)
    await lease.release()
  })

  it('detaches the shield synchronously for lease release and public toolbar takeover', async () => {
    const harness = createHarness()
    const { workspace, views, windows } = harness
    const { binding, registry } = await bindIdleContinuation(harness)
    const lease = await registry.acquire(binding.bindingId, {
      userId: 'user_1', conversationId: 'conversation_1', runId: 'run_release',
    })
    const [toolbar, target, shield] = views

    const releasing = lease.release()
    expect(windows[0]?.children).toEqual([target, toolbar])
    await releasing

    const replacement = await registry.acquire(binding.bindingId, {
      userId: 'user_1', conversationId: 'conversation_1', runId: 'run_takeover',
    })
    expect(windows[0]?.children).toEqual([target, shield, toolbar])
    expect(views).toHaveLength(3)
    expect(shield?.webContents.loaded).toHaveLength(1)
    const handlers = {
      stop: vi.fn(async () => undefined),
      takeOver: vi.fn(async () => { await replacement.release() }),
    }
    workspace.setContinuationCommandHandlers(handlers)
    const navigation = { preventDefault: vi.fn() }

    toolbar!.webContents.emit(
      'will-navigate', navigation, `autoforge-browser://continuation/takeover/${binding.bindingId}`,
    )

    expect(navigation.preventDefault).toHaveBeenCalledOnce()
    expect(handlers.takeOver).toHaveBeenCalledWith(binding.bindingId)
    expect(windows[0]?.children).toEqual([target, toolbar])
    await vi.waitFor(() => expect(replacement.isCurrent(binding)).toBe(false))
  })

  it('deduplicates concurrent input-shield creation across continuation tabs', async () => {
    const shieldLoad = deferred<void>()
    const harness = createHarness(
      () => ({}), false,
      async (url) => {
        if (url.startsWith('data:text/html')
          && decodeURIComponent(url).includes('<body aria-hidden="true">')) {
          await shieldLoad.promise
        }
      },
    )
    const { workspace, views, windows } = harness
    const firstInput = executionInput()
    const first = workspace.acquire(firstInput)
    await vi.waitFor(() => expect(views).toHaveLength(3))
    const secondInput = executionInput({
      executionId: 'e2', chatRunId: 'chat_run_2', workflowId: 'workflow.two',
    })
    const second = workspace.acquire(secondInput)
    await vi.waitFor(() => expect(views).toHaveLength(4))
    const shield = views[2]!
    expect(shield.webContents.loaded).toHaveLength(1)

    shieldLoad.resolve()
    await Promise.all([first, second])

    expect(views).toHaveLength(4)
    expect(windows[0]!.children).not.toContain(shield)
    await workspace.releaseExecution(firstInput.executionId)
    await workspace.releaseExecution(secondInput.executionId)
  })

  it('allows exactly one same-binding continuation to claim a tab while the shield loads', async () => {
    const shieldLoad = deferred<void>()
    let shieldLoads = 0
    const harness = createHarness(
      () => ({}), false,
      async (url) => {
        if (url.startsWith('data:text/html')
          && decodeURIComponent(url).includes('<body aria-hidden="true">')
          && ++shieldLoads === 2) {
          await shieldLoad.promise
        }
      },
    )
    const { views, windows } = harness
    const { binding, registry } = await bindIdleContinuation(harness)
    expect(views).toHaveLength(3)
    views[2]!.webContents.close()

    const first = registry.acquire(binding.bindingId, {
      userId: 'user_1', conversationId: 'conversation_1', runId: 'run_first',
    })
    await vi.waitFor(() => expect(views).toHaveLength(4))
    const second = registry.acquire(binding.bindingId, {
      userId: 'user_1', conversationId: 'conversation_1', runId: 'run_second',
    })
    shieldLoad.resolve()

    const results = await Promise.allSettled([first, second])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({ reason: { code: 'PAGE_BUSY' } })
    const lease = fulfilled[0]!.value
    expect(lease.isCurrent(binding)).toBe(true)
    expect(windows[0]!.children).toEqual([views[1], views[3], views[0]])
    await lease.release()
  })

  it('returns PAGE_BUSY when workflow ownership is claimed while the shield loads', async () => {
    const shieldLoad = deferred<void>()
    let shieldLoads = 0
    const harness = createHarness(
      () => ({}), false,
      async (url) => {
        if (url.startsWith('data:text/html')
          && decodeURIComponent(url).includes('<body aria-hidden="true">')
          && ++shieldLoads === 2) {
          await shieldLoad.promise
        }
      },
    )
    const { workspace, views, windows } = harness
    const { tab, binding, registry } = await bindIdleContinuation(harness)
    expect(views).toHaveLength(3)
    views[2]!.webContents.close()
    const continuation = registry.acquire(binding.bindingId, {
      userId: 'user_1', conversationId: 'conversation_1', runId: 'run_continuation',
    })
    await vi.waitFor(() => expect(views).toHaveLength(4))

    const workflow = await workspace.acquire(executionInput({
      executionId: 'e2', chatRunId: 'chat_run_2',
    }))
    expect(workflow.id).toBe(tab.id)
    shieldLoad.resolve()

    await expect(continuation).rejects.toMatchObject({ code: 'PAGE_BUSY' })
    expect(registry.currentLease(binding.bindingId)).toBeUndefined()
    expect(windows[0]!.children).toContain(views[0])
    expect(windows[0]!.children).toContain(views[1])
    expect(windows[0]!.children).not.toContain(views[2])
    expect(windows[0]!.children).not.toContain(views[3])
    await workspace.releaseExecution('e2')
  })

  it('closes an input shield whose window is replaced while its document loads', async () => {
    const shieldLoad = deferred<void>()
    let shieldLoads = 0
    const harness = createHarness(
      () => ({}), false,
      async (url) => {
        if (url.startsWith('data:text/html')
          && decodeURIComponent(url).includes('<body aria-hidden="true">')
          && ++shieldLoads === 2) {
          await shieldLoad.promise
        }
      },
    )
    const { workspace, views } = harness
    const { binding, registry } = await bindIdleContinuation(harness)
    expect(views).toHaveLength(3)
    views[2]!.webContents.close()

    const acquiring = registry.acquire(binding.bindingId, {
      userId: 'user_1', conversationId: 'conversation_1', runId: 'run_stale',
    })
    await vi.waitFor(() => expect(views).toHaveLength(4))
    const staleShield = views[3]!
    const resetting = workspace.reset()
    shieldLoad.resolve()

    await resetting
    await expect(acquiring).rejects.toMatchObject({ code: 'PAGE_CLOSED' })
    expect(staleShield.webContents.destroyed).toBe(true)
  })

  it('detaches the input shield synchronously when the leased active target crashes', async () => {
    const harness = createHarness()
    const { views, windows } = harness
    const { binding, registry } = await bindIdleContinuation(harness)
    const lease = await registry.acquire(binding.bindingId, {
      userId: 'user_1', conversationId: 'conversation_1', runId: 'run_crashed',
    })
    const [toolbar, target, shield] = views
    expect(windows[0]!.children).toEqual([target, shield, toolbar])

    target!.webContents.emit('render-process-gone', {}, { reason: 'crashed' })

    expect(target!.webContents.destroyed).toBe(true)
    expect(windows[0]!.children).toEqual([target, toolbar])
    expect(lease.isCurrent(binding)).toBe(false)
    await lease.release()
  })

  it.each(['back', 'forward', 'reload'] as const)(
    'releases continuation ownership before toolbar %s mutates the page',
    async (command) => {
      const { workspace, views } = createHarness()
      const input = executionInput()
      const tab = await workspace.acquire(input)
      const registry = continuationRegistry(workspace)
      workspace.setContinuationRegistry(registry)
      const binding = registry.bind({ ...input, tabId: tab.id } as BrowserContinuationBindingInput)
      await workspace.releaseExecution(input.executionId)
      const lease = await registry.acquire(binding.bindingId, {
        userId: input.userId, conversationId: input.conversationId!, runId: 'run_toolbar',
      })
      const target = views[1]!.webContents
      if (command === 'back') vi.spyOn(target.navigationHistory, 'canGoBack').mockReturnValue(true)
      if (command === 'forward') vi.spyOn(target.navigationHistory, 'canGoForward').mockReturnValue(true)
      const mutation = command === 'back'
        ? target.navigationHistory.goBack
        : command === 'forward' ? target.navigationHistory.goForward : target.reload
      let replacement: ReturnType<typeof registry.acquire> | undefined
      mutation.mockImplementation(() => {
        replacement = registry.acquire(binding.bindingId, {
          userId: input.userId, conversationId: input.conversationId!, runId: 'run_after_toolbar',
        })
      })

      const navigation = { preventDefault: vi.fn() }
      views[0]!.webContents.emit('will-navigate', navigation, `autoforge-browser://${command}`)

      expect(navigation.preventDefault).toHaveBeenCalledOnce()
      await vi.waitFor(() => expect(mutation).toHaveBeenCalledOnce())
      expect(replacement).toBeDefined()
      const replacementLease = await replacement!
      expect(replacementLease.ownerRunId).toBe('run_after_toolbar')
      await lease.release()
      await replacementLease.release()
    },
  )

  it('renders trusted continuation controls and routes exact live binding commands', async () => {
    const { workspace, views } = createHarness()
    const input = executionInput()
    const tab = await workspace.acquire(input)
    const registry = continuationRegistry(workspace)
    workspace.setContinuationRegistry(registry)
    const binding = registry.bind({ ...input, tabId: tab.id } as BrowserContinuationBindingInput)
    workspace.markContinuationBound(tab.id)
    await workspace.releaseExecution(input.executionId)
    const handlers = { stop: vi.fn(async () => undefined), takeOver: vi.fn(async () => undefined) }
    workspace.setContinuationCommandHandlers(handlers)
    const lease = await registry.acquire(binding.bindingId, {
      userId: input.userId, conversationId: input.conversationId!, runId: 'run_toolbar_controls',
    })

    await vi.waitFor(() => {
      const document = decodeURIComponent(views[0]!.webContents.loaded.at(-1)!.split(',')[1]!)
      expect(document).toContain('<span class="automation-state-dot" aria-hidden="true"></span>')
      expect(document).toContain('AI 正在操作网页')
      expect(document).toContain(`class="automation-stop" href="autoforge-browser://continuation/stop/${binding.bindingId}"`)
      expect(document).toContain(`class="automation-takeover" href="autoforge-browser://continuation/takeover/${binding.bindingId}"`)
    })
    expect(views[0]!.options.webPreferences).toMatchObject({ partition: 'autoforge-browser-toolbar' })
    expect(views[1]!.options.webPreferences).not.toMatchObject({ partition: 'autoforge-browser-toolbar' })

    const stopNavigation = { preventDefault: vi.fn() }
    views[0]!.webContents.emit(
      'will-navigate', stopNavigation,
      `autoforge-browser://continuation/stop/${binding.bindingId}`,
    )
    await vi.waitFor(() => expect(handlers.stop).toHaveBeenCalledWith(binding.bindingId))
    expect(stopNavigation.preventDefault).toHaveBeenCalledOnce()

    views[0]!.webContents.emit(
      'will-navigate', { preventDefault: vi.fn() },
      `autoforge-browser://continuation/takeover/${binding.bindingId}`,
    )
    await vi.waitFor(() => expect(handlers.takeOver).toHaveBeenCalledWith(binding.bindingId))
    await lease.release()
  })

  it('rejects forged, unknown, stale, and ambiguous continuation toolbar commands', async () => {
    const { workspace, views } = createHarness()
    const input = executionInput()
    const tab = await workspace.acquire(input)
    const registry = continuationRegistry(workspace)
    workspace.setContinuationRegistry(registry)
    const binding = registry.bind({ ...input, tabId: tab.id } as BrowserContinuationBindingInput)
    workspace.markContinuationBound(tab.id)
    await workspace.releaseExecution(input.executionId)
    const handlers = { stop: vi.fn(async () => undefined), takeOver: vi.fn(async () => undefined) }
    workspace.setContinuationCommandHandlers(handlers)
    const lease = await registry.acquire(binding.bindingId, {
      userId: input.userId, conversationId: input.conversationId!, runId: 'run_toolbar_rejection',
    })
    const toolbar = views[0]!.webContents

    toolbar.emit(
      'will-navigate', { preventDefault: vi.fn() },
      `autoforge-browser://continuation/stop/${binding.bindingId}`,
    )
    await vi.waitFor(() => expect(handlers.stop).toHaveBeenCalledWith(binding.bindingId))
    handlers.stop.mockClear()

    for (const command of [
      'autoforge-browser://continuation/stop/binding_999',
      `autoforge-browser://continuation/stop/${binding.bindingId}/extra`,
      `autoforge-browser://continuation/stop/${binding.bindingId}?again=1`,
      `autoforge-browser://continuation/stop/${binding.bindingId}#again`,
      `autoforge-browser://continuation/stop/${binding.bindingId.replace('_', '%5F')}`,
      'autoforge-browser://continuation/stop/../binding_1',
      'autoforge-browser://continuation/stop/%2Fbinding_1',
      `autoforge-browser://continuation/takeover/${binding.bindingId}/extra`,
    ]) toolbar.emit('will-navigate', { preventDefault: vi.fn() }, command)
    views[1]!.webContents.emit(
      'will-navigate', { preventDefault: vi.fn() },
      `autoforge-browser://continuation/stop/${binding.bindingId}`,
    )
    await Promise.resolve()
    expect(handlers.stop).not.toHaveBeenCalled()
    expect(handlers.takeOver).not.toHaveBeenCalled()

    await lease.release()
    toolbar.emit(
      'will-navigate', { preventDefault: vi.fn() },
      `autoforge-browser://continuation/stop/${binding.bindingId}`,
    )
    await Promise.resolve()
    expect(handlers.stop).not.toHaveBeenCalled()
  })

  it('cancels an in-flight continuation action when toolbar navigation takes over', async () => {
    const dispatched = deferred<unknown>()
    const respond = (method: string) => ({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'Accessibility.queryAXTree': {
        nodes: [{ backendDOMNodeId: 80, ignored: false, role: { value: 'button' }, name: { value: '继续' } }],
      },
      'DOM.getBoxModel': { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } },
    } as Record<string, unknown>)[method]
      ?? (method === 'Input.dispatchMouseEvent' ? dispatched.promise : {})
    const { workspace, views } = createHarness(respond)
    const input = executionInput()
    const tab = await workspace.acquire(input)
    await tab.open('https://www.baidu.com/start', ['https://www.baidu.com'])
    const registry = continuationRegistry(workspace)
    workspace.setContinuationRegistry(registry)
    const binding = registry.bind({ ...input, tabId: tab.id } as BrowserContinuationBindingInput)
    await workspace.releaseExecution(input.executionId)
    const lease = await registry.acquire(binding.bindingId, {
      userId: input.userId, conversationId: input.conversationId!, runId: 'run_in_flight',
    })

    const clicking = tab.click('role=button[name="继续"]', 'https://www.baidu.com')
    await vi.waitFor(() => expect(views[1]!.webContents.debugger.commands)
      .toContainEqual(expect.objectContaining({ method: 'Input.dispatchMouseEvent' })))
    views[0]!.webContents.emit(
      'will-navigate', { preventDefault: vi.fn() }, 'autoforge-browser://reload',
    )
    dispatched.resolve({})

    await expect(clicking).rejects.toMatchObject({ code: 'CANCELLED' })
    const replacement = await registry.acquire(binding.bindingId, {
      userId: input.userId, conversationId: input.conversationId!, runId: 'run_after_toolbar',
    })
    await lease.release()
    await replacement.release()
  })

  it('takes over an automated tab before trusted-toolbar activation can select another tab', async () => {
    const dispatched = deferred<unknown>()
    const respond = (method: string) => ({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'Accessibility.queryAXTree': {
        nodes: [{ backendDOMNodeId: 80, ignored: false, role: { value: 'button' }, name: { value: '继续' } }],
      },
      'DOM.getBoxModel': { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } },
    } as Record<string, unknown>)[method]
      ?? (method === 'Input.dispatchMouseEvent' ? dispatched.promise : {})
    const { workspace, views, windows } = createHarness(respond)
    const input = executionInput()
    const automated = await workspace.acquire(input)
    await automated.open('https://www.baidu.com/start', ['https://www.baidu.com'])
    await workspace.releaseExecution(input.executionId)
    const selected = await workspace.acquire(executionInput({
      executionId: 'execution_selected',
      chatRunId: 'chat_run_selected',
      workflowId: 'workflow.selected',
    }))
    await workspace.releaseExecution('execution_selected')
    const registry = continuationRegistry(workspace)
    workspace.setContinuationRegistry(registry)
    const binding = registry.bind({ ...input, tabId: automated.id } as BrowserContinuationBindingInput)
    const lease = await registry.acquire(binding.bindingId, {
      userId: input.userId, conversationId: input.conversationId!, runId: 'run_tab_switch',
    })
    await workspace.focusContinuation(automated.id, 'run_tab_switch')

    const clicking = automated.click('role=button[name="继续"]', 'https://www.baidu.com')
    await vi.waitFor(() => expect(views[1]!.webContents.debugger.commands)
      .toContainEqual(expect.objectContaining({ method: 'Input.dispatchMouseEvent' })))
    views[0]!.webContents.emit(
      'will-navigate', { preventDefault: vi.fn() }, `autoforge-browser://activate/${selected.id}`,
    )

    await vi.waitFor(() => expect(lease.isCurrent(binding)).toBe(false))
    dispatched.resolve({})
    await expect(clicking).rejects.toMatchObject({ code: 'CANCELLED' })
    await vi.waitFor(() => {
      expect(windows[0]!.children).toContain(views[3])
      expect(windows[0]!.children).not.toContain(views[1])
    })
    await lease.release()
  })

  it('inherits a separate binding only for an allowed popup after the parent was bound', async () => {
    const { workspace, views } = createHarness()
    const registry = continuationRegistry(workspace)
    workspace.setContinuationRegistry(registry)
    const input = executionInput()
    const parent = await workspace.acquire(input)
    await parent.open('https://www.baidu.com/start', ['https://www.baidu.com'])
    const parentBinding = registry.bind({ ...input, tabId: parent.id } as BrowserContinuationBindingInput)
    workspace.markContinuationBound(parent.id)

    expect(views[1]!.webContents.windowOpenHandler?.({ url: 'https://www.baidu.com/child' }))
      .toEqual({ action: 'deny' })
    await vi.waitFor(() => expect(registry.list('user_1', 'conversation_1')).toHaveLength(2))
    const child = registry.list('user_1', 'conversation_1').find(({ bindingId }) => bindingId !== parentBinding.bindingId)

    expect(child).toMatchObject({ conversationId: 'conversation_1', workflowId: 'workflow.one' })
    expect(child?.tabId).not.toBe(parent.id)
  })

  it('denies a disallowed popup visibly without creating a child binding', async () => {
    const { workspace, views } = createHarness()
    const registry = continuationRegistry(workspace)
    workspace.setContinuationRegistry(registry)
    const input = executionInput()
    const parent = await workspace.acquire(input)
    await parent.open('https://www.baidu.com/start', ['https://www.baidu.com'])
    registry.bind({ ...input, tabId: parent.id } as BrowserContinuationBindingInput)
    workspace.markContinuationBound(parent.id)

    expect(views[1]!.webContents.windowOpenHandler?.({ url: 'https://attacker.example/' }))
      .toEqual({ action: 'deny' })
    await vi.waitFor(() => {
      const toolbar = decodeURIComponent(views[0]!.webContents.loaded.at(-1)!.split(',')[1]!)
      expect(toolbar).toContain('DOMAIN_BLOCKED')
    })

    expect(registry.list('user_1', 'conversation_1')).toHaveLength(1)
    expect(views).toHaveLength(3)
  })

  it('closes an unbound provisional popup when its load rejects', async () => {
    const popupUrl = 'https://www.baidu.com/load-fails'
    const { workspace, views } = createHarness(
      () => ({}), false,
      async (url) => { if (url === popupUrl) throw new Error('load failed') },
    )
    const registry = continuationRegistry(workspace)
    const bindPopup = vi.spyOn(registry, 'bindPopup')
    workspace.setContinuationRegistry(registry)
    const input = executionInput()
    const parent = await workspace.acquire(input)
    await parent.open('https://www.baidu.com/start', ['https://www.baidu.com'])
    registry.bind({ ...input, tabId: parent.id } as BrowserContinuationBindingInput)
    workspace.markContinuationBound(parent.id)

    views[1]!.webContents.windowOpenHandler?.({ url: popupUrl })

    await vi.waitFor(() => expect(views).toHaveLength(4))
    await vi.waitFor(() => expect(views[3]!.webContents.destroyed).toBe(true))
    expect(bindPopup).not.toHaveBeenCalled()
    expect(registry.list(input.userId, input.conversationId!)).toHaveLength(1)
  })

  it('closes an unbound provisional popup after a post-load redirect leaves its captured patterns', async () => {
    const popupUrl = 'https://www.baidu.com/redirects'
    const { workspace, views } = createHarness(
      () => ({}), false, undefined,
      (url) => url === popupUrl ? 'https://attacker.example/landing' : undefined,
    )
    const registry = continuationRegistry(workspace)
    const bindPopup = vi.spyOn(registry, 'bindPopup')
    workspace.setContinuationRegistry(registry)
    const input = executionInput()
    const parent = await workspace.acquire(input)
    await parent.open('https://www.baidu.com/start', ['https://www.baidu.com'])
    registry.bind({ ...input, tabId: parent.id } as BrowserContinuationBindingInput)
    workspace.markContinuationBound(parent.id)

    views[1]!.webContents.windowOpenHandler?.({ url: popupUrl })

    await vi.waitFor(() => expect(views).toHaveLength(4))
    await vi.waitFor(() => expect(views[3]!.webContents.destroyed).toBe(true))
    expect(bindPopup).not.toHaveBeenCalled()
    expect(registry.list(input.userId, input.conversationId!)).toHaveLength(1)
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
    const tab = await acquire(workspace, 'exec_1')
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
    expect(tab.navigationEpoch).toBe(2)
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

  it('closes live continuation authority when the bound renderer crashes', async () => {
    const { workspace, views } = createHarness()
    const input = executionInput()
    const tab = await workspace.acquire(input)
    const registry = continuationRegistry(workspace)
    workspace.setContinuationRegistry(registry)
    registry.bind({ ...input, tabId: tab.id } as BrowserContinuationBindingInput)

    views[1]!.webContents.emit('render-process-gone', {}, { reason: 'crashed' })

    expect(registry.list('user_1', 'conversation_1')).toEqual([])
    await expect(registry.acquire('binding_1', {
      userId: 'user_1', conversationId: 'conversation_1', runId: 'run_after_crash',
    })).rejects.toMatchObject({ code: 'PAGE_CLOSED' })
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

  it('closes and clears only one hashed user partition for an explicit browser-data reset', async () => {
    const { workspace, sessions, views, fromPartition } = createHarness()
    const sessionStorageStore: BrowserSessionStorageStore = {
      get: vi.fn(async () => ({})),
      apply: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      drain: vi.fn(async () => undefined),
    }
    workspace.setSessionStorageStore(sessionStorageStore)
    await acquire(workspace, 'exec_1', 'user_1')
    await workspace.releaseExecution('exec_1')
    await acquire(workspace, 'exec_2', 'user_2')
    await workspace.releaseExecution('exec_2')
    const userOnePartition = browserPartition('user_1')
    const userTwoPartition = browserPartition('user_2')

    await workspace.clearUserData('user_1')

    expect(views[1]!.webContents.destroyed).toBe(true)
    expect(views[2]!.webContents.destroyed).toBe(false)
    expect(sessions.get(userOnePartition)?.clearStorageData).toHaveBeenCalledOnce()
    expect(sessions.get(userOnePartition)?.clearCache).toHaveBeenCalledOnce()
    expect(sessions.get(userTwoPartition)?.clearStorageData).not.toHaveBeenCalled()
    expect(sessions.get(userTwoPartition)?.clearCache).not.toHaveBeenCalled()
    expect(sessions.get('autoforge-browser-toolbar')?.clearStorageData).not.toHaveBeenCalled()
    expect(fromPartition).toHaveBeenCalledWith(userOnePartition)
    expect([...sessions.keys()]).not.toContain('default')
    expect(sessionStorageStore.drain).toHaveBeenCalledOnce()
    expect(sessionStorageStore.clear).toHaveBeenCalledOnce()
    expect(sessionStorageStore.clear).toHaveBeenCalledWith('user_1')
  })

  it('refuses to clear a user partition while that user still owns execution or continuation work', async () => {
    const { workspace, sessions } = createHarness()
    const tab = await acquire(workspace, 'exec_1', 'user_1')

    await expect(workspace.clearUserData('user_1'))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    expect(sessions.get(browserPartition('user_1'))?.clearStorageData).not.toHaveBeenCalled()

    await workspace.releaseExecution('exec_1')
    await workspace.acquireContinuation(tab.id, 'agent_run_1')
    await expect(workspace.clearUserData('user_1'))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    expect(sessions.get(browserPartition('user_1'))?.clearCache).not.toHaveBeenCalled()
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

  it('allows a cross-origin redirect covered by the browser.open URL patterns', async () => {
    const { workspace, views } = createHarness()
    const tab = await acquire(workspace, 'exec_1')
    const target = views[1]!.webContents
    const initialUrl = 'https://fw.bjrcgz.gov.cn/person-platform/'
    const loginUrl = 'https://portal.bjt.beijing.gov.cn/p/login/login.html'
    vi.spyOn(target, 'loadURL').mockImplementationOnce(async (url) => {
      target.loaded.push(url)
      target.currentUrl = url
      target.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
      target.currentUrl = loginUrl
      target.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
      target.emit('did-fail-load', {}, -3, 'ERR_ABORTED', initialUrl, true)
      setTimeout(() => target.emit('did-stop-loading'), 5)
      throw Object.assign(new Error('navigation replaced'), { code: 'ERR_ABORTED', errno: -3, url: loginUrl })
    })

    await expect(tab.open(
      initialUrl,
      ['https://fw.bjrcgz.gov.cn'],
      ['https://*.bjt.beijing.gov.cn'],
    )).resolves.toBeUndefined()

    expect(await tab.url()).toBe(loginUrl)
    const returnToInitial = { preventDefault: vi.fn() }
    target.emit('will-navigate', returnToInitial, initialUrl)
    expect(returnToInitial.preventDefault).toHaveBeenCalledOnce()
  })

  it('blocks a cross-origin redirect outside the browser.open URL patterns', async () => {
    const { workspace, views } = createHarness()
    const tab = await acquire(workspace, 'exec_1')
    const target = views[1]!.webContents
    const initialUrl = 'https://fw.bjrcgz.gov.cn/person-platform/'
    const denied = { preventDefault: vi.fn() }
    vi.spyOn(target, 'loadURL').mockImplementationOnce(async (url) => {
      target.loaded.push(url)
      target.currentUrl = url
      target.emit(
        'will-redirect',
        denied,
        'https://portal.bjt.beijing.gov.cn/admin/',
      )
      throw Object.assign(new Error('navigation replaced'), { code: 'ERR_ABORTED', errno: -3 })
    })

    await expect(tab.open(
      initialUrl,
      ['https://fw.bjrcgz.gov.cn'],
      ['https://*.bjt.beijing.gov.cn/login/*'],
    )).rejects.toMatchObject({ code: 'CAPABILITY_SCOPE_DENIED' })

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
