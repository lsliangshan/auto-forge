import { describe, expect, it, vi } from 'vitest'
import type { BrowserContinuationBinding } from './browser-continuation-types.js'
import {
  BrowserPageInspector,
  type BrowserInspectionNode,
  type BrowserPageCdpPort,
  type BrowserPageReadResult,
} from './browser-page-inspector.js'

const origin = 'https://fw.bjrcgz.gov.cn'

function binding(
  browserContinuation: BrowserContinuationBinding['browserContinuation'] = {
    auth: {
      loginUrls: ['https://fw.bjrcgz.gov.cn/login*'],
      loggedIn: ['role=button[name="退出"]'],
      loggedOut: ['css=form#login'],
    },
    readableRegions: ['role=main'],
  },
): BrowserContinuationBinding {
  const value: BrowserContinuationBinding = {
    bindingId: 'binding_1',
    tabId: 'tab_1',
    userId: 'user_1',
    conversationId: 'conversation_1',
    chatRunId: 'workflow_chat_run_1',
    executionId: 'execution_1',
    workflowId: 'workflow.one',
    workflowVersion: '1.0.0',
    source: 'installed',
    securityFingerprint: 'a'.repeat(64),
    permissionMatrix: {
      'browser.open': ['https://fw.bjrcgz.gov.cn/*'],
      'browser.url': ['https://fw.bjrcgz.gov.cn/*'],
    },
    ...(browserContinuation === undefined ? {} : { browserContinuation }),
    createdAt: 1,
    status: 'active',
  }
  return deepFreeze(value)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function node(
  backendNodeId: number,
  role: string,
  name: string,
  overrides: Partial<BrowserInspectionNode> = {},
): BrowserInspectionNode {
  return {
    axNodeId: `ax_${backendNodeId}`,
    parentAxNodeId: 'ax_main',
    backendNodeId,
    role,
    name,
    enabled: true,
    ignored: false,
    frameId: 'frame_main',
    dom: { tagName: role === 'textbox' ? 'input' : 'div' },
    ...overrides,
  }
}

class FakeCdpPort implements BrowserPageCdpPort {
  page: BrowserPageReadResult
  readonly readAccessibilitySnapshot = vi.fn(async () => this.page)
  readonly readNode = vi.fn(async (input: { backendNodeId: number }) => (
    this.page.nodes.find((candidate) => candidate.backendNodeId === input.backendNodeId)
  ))
  readonly getNodeBox = vi.fn(async () => ({
    x: 20, y: 30, width: 320, height: 200, viewportWidth: 1200, viewportHeight: 800,
  }))
  readonly captureNodeScreenshot = vi.fn(async () => 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB')
  private readonly invalidationListeners = new Set<(tabId: string) => void>()

  constructor(nodes: readonly BrowserInspectionNode[], overrides: Partial<BrowserPageReadResult> = {}) {
    this.page = {
      tabId: 'tab_1',
      navigationEpoch: 4,
      origin,
      url: `${origin}/person-platform/detail?identity=110101199001010000`,
      title: '北京市政务服务',
      frameId: 'frame_main',
      viewportWidth: 1200,
      viewportHeight: 800,
      nodes,
      locatorMatches: [
        { locator: 'role=main', backendNodeIds: [10] },
        { locator: 'role=button[name="退出"]', backendNodeIds: [19] },
        { locator: 'css=form#login', backendNodeIds: [] },
      ],
      ...overrides,
    }
  }

  onPageInvalidated(listener: (tabId: string) => void): () => void {
    this.invalidationListeners.add(listener)
    return () => { this.invalidationListeners.delete(listener) }
  }

  invalidate(tabId = 'tab_1'): void {
    for (const listener of this.invalidationListeners) listener(tabId)
  }
}

function input(
  exactBinding = binding(),
  overrides: Record<string, unknown> = {},
) {
  return {
    runId: 'agent_run_1',
    binding: exactBinding,
    tabId: 'tab_1',
    navigationEpoch: 4,
    origin,
    intent: '查询工作居住证有效期',
    mode: 'semantic' as const,
    ...overrides,
  }
}

function idSequence(): () => string {
  let current = 0
  return () => String(++current).padStart(4, '0')
}

describe('BrowserPageInspector', () => {
  it('returns only bounded readable semantic data and drops realistic secret-bearing nodes', async () => {
    const port = new FakeCdpPort([
      node(10, 'main', '办事详情', { axNodeId: 'ax_main', parentAxNodeId: undefined }),
      node(11, 'textbox', '有效期至', { value: '2028-06-30', dom: { tagName: 'input', inputType: 'date', readOnly: true } }),
      node(12, 'textbox', '密码 password', { value: 'hunter2', dom: { tagName: 'input', inputType: 'password' } }),
      node(13, 'textbox', '短信验证码', { value: '848204', dom: { tagName: 'input', autocomplete: 'one-time-code' } }),
      node(14, 'img', 'CAPTCHA 验证码图片'),
      node(15, 'textbox', '内部字段', { value: 'hidden-token', dom: { tagName: 'input', inputType: 'hidden', hidden: true } }),
      node(16, 'statictext', '身份证号 110101199001010000'),
      node(17, 'statictext', 'cookie=session-secret'),
      node(18, 'button', '正式提交'),
      node(19, 'button', '退出'),
      node(77, 'statictext', '声明区域外公开值', { parentAxNodeId: undefined }),
      node(99, 'statictext', '另一个 frame 的隐私', { frameId: 'frame_other' }),
    ])
    const inspector = new BrowserPageInspector(port, { id: idSequence(), now: () => 1_787_415_600_000 })

    const snapshot = await inspector.inspect(input())

    expect(snapshot).toMatchObject({
      bindingId: 'binding_1', origin, navigationEpoch: 4, auth: 'unknown',
      url: `${origin}/person-platform/detail`, capturedAt: '2026-08-22T16:20:00.000Z',
    })
    expect(snapshot.nodes).toContainEqual(expect.objectContaining({
      role: 'textbox', name: '有效期至', value: '2028-06-30', actions: [],
    }))
    expect(snapshot.nodes).toContainEqual(expect.objectContaining({ role: 'button', name: '正式提交' }))
    expect(JSON.stringify(snapshot)).not.toMatch(
      /password|hunter2|cookie|session-secret|110101199001010000|hidden-token|848204|captcha|短信验证码|声明区域外|另一个 frame/i,
    )
    expect(JSON.stringify(snapshot)).not.toMatch(/backendNodeId|selector|coordinates|attributes|identity=/i)
    expect(snapshot.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(snapshot), 'utf8'))
    expect(snapshot.serializedBytes).toBeLessThanOrEqual(128 * 1024)
    expect(snapshot.nodes.length).toBeLessThanOrEqual(500)
    expect(port.readAccessibilitySnapshot).toHaveBeenCalledWith(expect.objectContaining({
      locators: [
        'role=button[name="退出"]',
        'css=form#login',
        'role=main',
      ],
    }))
  })

  it.each([
    {
      evidence: 'password control',
      nodes: [node(10, 'main', '账户', { axNodeId: 'ax_main', parentAxNodeId: undefined }), node(11, 'textbox', '口令', { dom: { tagName: 'input', inputType: 'password' } })],
      continuation: undefined,
      overrides: {},
      expected: 'required',
    },
    {
      evidence: 'OTP control',
      nodes: [node(10, 'main', '账户', { axNodeId: 'ax_main', parentAxNodeId: undefined }), node(11, 'textbox', '动态码', { dom: { tagName: 'input', autocomplete: 'one-time-code' } })],
      continuation: undefined,
      overrides: {},
      expected: 'required',
    },
    {
      evidence: 'CAPTCHA image',
      nodes: [node(10, 'main', '账户', { axNodeId: 'ax_main', parentAxNodeId: undefined }), node(11, 'img', '验证码')],
      continuation: undefined,
      overrides: {},
      expected: 'required',
    },
    {
      evidence: 'explicit login URL',
      nodes: [node(10, 'main', '登录页', { axNodeId: 'ax_main', parentAxNodeId: undefined })],
      continuation: { auth: { loginUrls: ['https://fw.bjrcgz.gov.cn/login*'] } },
      overrides: { url: `${origin}/login?ticket=private-ticket` },
      expected: 'required',
    },
    {
      evidence: 'declared logged-out marker',
      nodes: [node(10, 'main', '账户', { axNodeId: 'ax_main', parentAxNodeId: undefined }), node(12, 'form', '登录')],
      continuation: { auth: { loggedOut: ['css=form#login'] } },
      overrides: { locatorMatches: [{ locator: 'css=form#login', backendNodeIds: [12] }] },
      expected: 'required',
    },
    {
      evidence: 'declared logged-in marker',
      nodes: [node(10, 'main', '账户', { axNodeId: 'ax_main', parentAxNodeId: undefined }), node(19, 'button', '退出')],
      continuation: { auth: { loggedIn: ['role=button[name="退出"]'] } },
      overrides: { locatorMatches: [{ locator: 'role=button[name="退出"]', backendNodeIds: [19] }] },
      expected: 'authenticated',
    },
    {
      evidence: 'conflicting required and authenticated evidence',
      nodes: [node(10, 'main', '账户', { axNodeId: 'ax_main', parentAxNodeId: undefined }), node(11, 'textbox', '口令', { dom: { tagName: 'input', inputType: 'password' } }), node(19, 'button', '退出')],
      continuation: { auth: { loggedIn: ['role=button[name="退出"]'] } },
      overrides: { locatorMatches: [{ locator: 'role=button[name="退出"]', backendNodeIds: [19] }] },
      expected: 'unknown',
    },
    {
      evidence: 'insufficient evidence',
      nodes: [node(10, 'main', '公开信息', { axNodeId: 'ax_main', parentAxNodeId: undefined })],
      continuation: undefined,
      overrides: {},
      expected: 'unknown',
    },
  ])('classifies auth from $evidence without exposing authentication values', async ({ nodes, continuation, overrides, expected }) => {
    const port = new FakeCdpPort(nodes, overrides)
    const inspector = new BrowserPageInspector(port, { id: idSequence() })

    const snapshot = await inspector.inspect(input(binding(continuation)))

    expect(snapshot.auth).toBe(expected)
    expect(JSON.stringify(snapshot.nodes)).not.toMatch(/private-ticket|password|动态码|验证码|口令/i)
  })

  it('exposes only role-supported actions granted by the exact binding matrix', async () => {
    const exactBinding = deepFreeze({
      ...binding({ readableRegions: ['role=main'] }),
      permissionMatrix: {
        'browser.open': [`${origin}/*`],
        'browser.fill': [`${origin}/*`],
        'browser.click': [`${origin}/*`],
      },
    })
    const port = new FakeCdpPort([
      node(10, 'main', '表单', { axNodeId: 'ax_main', parentAxNodeId: undefined }),
      node(11, 'textbox', '姓名'),
      node(12, 'combobox', '类别'),
      node(13, 'button', '查询'),
      node(14, 'checkbox', '仅显示有效记录'),
      node(15, 'button', '不可用', { enabled: false }),
    ])
    port.page = {
      ...port.page,
      locatorMatches: [{ locator: 'role=main', backendNodeIds: [10] }],
    }
    const inspector = new BrowserPageInspector(port, { id: idSequence() })

    const snapshot = await inspector.inspect(input(exactBinding))
    const actions = Object.fromEntries(snapshot.nodes.map((candidate) => [candidate.name, candidate.actions]))

    expect(actions).toMatchObject({
      姓名: ['fill'], 类别: ['select'], 查询: ['click'], 仅显示有效记录: ['check'], 不可用: [],
    })

    const wrongOriginBinding = deepFreeze({
      ...exactBinding,
      permissionMatrix: {
        ...exactBinding.permissionMatrix,
        'browser.fill': ['https://other.example/*'],
      },
    })
    const crossOriginSnapshot = await inspector.inspect(input(wrongOriginBinding))
    const crossOriginActions = Object.fromEntries(
      crossOriginSnapshot.nodes.map((candidate) => [candidate.name, candidate.actions]),
    )
    expect(crossOriginActions).toMatchObject({ 姓名: [], 类别: [], 查询: ['click'] })
  })

  it('paginates under exact byte/node limits with an opaque single-owner cursor', async () => {
    const manyNodes = [
      node(10, 'main', '查询结果', { axNodeId: 'ax_main', parentAxNodeId: undefined }),
      ...Array.from({ length: 620 }, (_, index) => node(100 + index, 'row', `结果 ${index} ${'市政服务'.repeat(90)}`)),
    ]
    const port = new FakeCdpPort(manyNodes)
    port.page = {
      ...port.page,
      locatorMatches: [{ locator: 'role=main', backendNodeIds: [10] }],
    }
    const inspector = new BrowserPageInspector(port, { id: idSequence() })

    const first = await inspector.inspect(input(binding({ readableRegions: ['role=main'] })))

    expect(first.nodes.length).toBeLessThan(500)
    expect(first.serializedBytes).toBeLessThanOrEqual(128 * 1024)
    expect(first.cursor).toMatch(/^cursor_[A-Za-z0-9_-]+$/)
    await expect(inspector.inspect(input(binding({ readableRegions: ['role=main'] }), {
      runId: 'other_run', cursor: first.cursor,
    }))).rejects.toMatchObject({ code: 'PAGE_CHANGED' })
    const otherBinding = deepFreeze({
      ...binding({ readableRegions: ['role=main'] }), bindingId: 'binding_2',
    })
    await expect(inspector.inspect(input(binding({ readableRegions: ['role=main'] }), {
      binding: otherBinding, cursor: first.cursor,
    }))).rejects.toMatchObject({ code: 'PAGE_CHANGED' })

    const second = await inspector.inspect(input(binding({ readableRegions: ['role=main'] }), { cursor: first.cursor }))
    expect(second.snapshotId).toBe(first.snapshotId)
    expect(second.nodes[0]?.ref).not.toBe(first.nodes[0]?.ref)
    expect(second.serializedBytes).toBeLessThanOrEqual(128 * 1024)
    await expect(inspector.inspect(input(binding({ readableRegions: ['role=main'] }), { cursor: first.cursor })))
      .rejects.toMatchObject({ code: 'PAGE_CHANGED' })
  })

  it('paginates after exactly 500 short semantic nodes even when the byte budget has room', async () => {
    const port = new FakeCdpPort([
      node(10, 'main', '结果', { axNodeId: 'ax_main', parentAxNodeId: undefined }),
      ...Array.from({ length: 620 }, (_, index) => node(100 + index, 'row', `结果 ${index}`)),
    ])
    port.page = {
      ...port.page,
      locatorMatches: [{ locator: 'role=main', backendNodeIds: [10] }],
    }
    const inspector = new BrowserPageInspector(port, { id: idSequence() })

    const first = await inspector.inspect(input(binding({ readableRegions: ['role=main'] })))

    expect(first.nodes).toHaveLength(500)
    expect(first.serializedBytes).toBeLessThan(128 * 1024)
    expect(first.cursor).toMatch(/^cursor_/)
    const second = await inspector.inspect(input(binding({ readableRegions: ['role=main'] }), { cursor: first.cursor }))
    expect(second.nodes).toHaveLength(121)
  })

  it('invalidates refs on navigation, origin change, tab close, and terminal run cleanup', async () => {
    const port = new FakeCdpPort([
      node(10, 'main', '详情', { axNodeId: 'ax_main', parentAxNodeId: undefined }),
      node(11, 'textbox', '有效期至', { value: '2028-06-30' }),
    ])
    const inspector = new BrowserPageInspector(port, { id: idSequence() })
    const first = await inspector.inspect(input(binding({ readableRegions: ['role=main'] })))
    const target = first.nodes.find((candidate) => candidate.name === '有效期至')!

    await expect(inspector.resolveRef({
      runId: 'agent_run_1', bindingId: 'binding_1', tabId: 'tab_1', snapshotId: first.snapshotId,
      navigationEpoch: 5, origin, ref: target.ref,
    })).rejects.toMatchObject({ code: 'PAGE_CHANGED' })
    await expect(inspector.resolveRef({
      runId: 'agent_run_1', bindingId: 'binding_1', tabId: 'tab_1', snapshotId: first.snapshotId,
      navigationEpoch: 4, origin: 'https://other.example', ref: target.ref,
    })).rejects.toMatchObject({ code: 'PAGE_CHANGED' })

    port.invalidate()
    await expect(inspector.resolveRef({
      runId: 'agent_run_1', bindingId: 'binding_1', tabId: 'tab_1', snapshotId: first.snapshotId,
      navigationEpoch: 4, origin, ref: target.ref,
    })).rejects.toMatchObject({ code: 'PAGE_CHANGED' })

    const next = await inspector.inspect(input(binding({ readableRegions: ['role=main'] })))
    inspector.endRun('agent_run_1')
    await expect(inspector.resolveRef({
      runId: 'agent_run_1', bindingId: 'binding_1', tabId: 'tab_1', snapshotId: next.snapshotId,
      navigationEpoch: 4, origin, ref: next.nodes[0]!.ref,
    })).rejects.toMatchObject({ code: 'PAGE_CHANGED' })
  })

  it('captures only a current safe bounded node for a vision-capable model', async () => {
    const port = new FakeCdpPort([
      node(10, 'main', '详情', { axNodeId: 'ax_main', parentAxNodeId: undefined }),
      node(11, 'img', '办理进度图'),
    ])
    port.getNodeBox.mockResolvedValue({
      x: 20, y: 30, width: 1000, height: 1000, viewportWidth: 1400, viewportHeight: 1200,
    })
    const inspector = new BrowserPageInspector(port, { id: idSequence(), now: () => 1_787_415_600_000 })
    const snapshot = await inspector.inspect(input(binding({ readableRegions: ['role=main'] })))
    const target = snapshot.nodes.find((candidate) => candidate.name === '办理进度图')!

    await expect(inspector.inspect(input(binding({ readableRegions: ['role=main'] }), {
      mode: 'region_image', ref: target.ref, visionSupported: false,
    }))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTROL' })

    const image = await inspector.inspect(input(binding({ readableRegions: ['role=main'] }), {
      mode: 'region_image', ref: target.ref, visionSupported: true,
    }))

    expect(image).toEqual({
      snapshotId: snapshot.snapshotId,
      bindingId: 'binding_1', origin, ref: target.ref,
      capturedAt: '2026-08-22T16:20:00.000Z', mediaType: 'image/png',
      width: 1000, height: 1000, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    })
    expect(port.captureNodeScreenshot).toHaveBeenCalledWith(expect.objectContaining({
      backendNodeId: 11,
      clip: { x: 20, y: 30, width: 1000, height: 1000 },
    }))

    port.page = {
      ...port.page,
      nodes: [
        ...port.page.nodes,
        node(12, 'textbox', '银行卡支付', { parentAxNodeId: 'ax_11' }),
      ],
    }
    await expect(inspector.inspect(input(binding({ readableRegions: ['role=main'] }), {
      mode: 'region_image', ref: target.ref, visionSupported: true,
    }))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTROL' })
    expect(port.captureNodeScreenshot).toHaveBeenCalledOnce()
  })

  it.each([
    { kind: 'over the pixel cap', target: node(11, 'img', '超大图'), box: { x: 0, y: 0, width: 1001, height: 1000, viewportWidth: 1400, viewportHeight: 1000 } },
    { kind: 'full page', target: node(11, 'document', '完整页面', { dom: { tagName: 'html' } }), box: { x: 0, y: 0, width: 1200, height: 800, viewportWidth: 1200, viewportHeight: 800 } },
    { kind: 'authentication', target: node(11, 'img', '验证码') },
    { kind: 'payment', target: node(11, 'group', '银行卡支付') },
    { kind: 'file', target: node(11, 'textbox', '上传附件', { dom: { tagName: 'input', inputType: 'file' } }) },
    { kind: 'signature', target: node(11, 'img', '手写签名') },
  ])('refuses $kind regions before capturing screenshot pixels', async ({ target, box }) => {
    const port = new FakeCdpPort([
      node(10, 'main', '详情', { axNodeId: 'ax_main', parentAxNodeId: undefined }),
      target,
    ])
    if (box) port.getNodeBox.mockResolvedValue(box)
    const inspector = new BrowserPageInspector(port, { id: idSequence() })
    const snapshot = await inspector.inspect(input(binding({ readableRegions: ['role=main'] })))
    const exposed = snapshot.nodes.find((candidate) => candidate.name === target.name)

    if (!exposed) {
      expect(target.name).toMatch(/验证码/)
      expect(port.captureNodeScreenshot).not.toHaveBeenCalled()
      return
    }
    await expect(inspector.inspect(input(binding({ readableRegions: ['role=main'] }), {
      mode: 'region_image', ref: exposed.ref, visionSupported: true,
    }))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTROL' })
    expect(port.captureNodeScreenshot).not.toHaveBeenCalled()
  })
})
