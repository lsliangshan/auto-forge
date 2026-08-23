import { describe, expect, it, vi } from 'vitest'
import type {
  BrowserContinuationBinding,
  BrowserContinuationLease,
} from './browser-continuation-types.js'
import { BrowserContinuationRegistry } from './browser-continuation-registry.js'
import {
  BrowserPageInspector,
  MAX_BROWSER_INSPECTION_LOCATOR_MATCHES,
  MAX_BROWSER_INSPECTION_RAW_NODES,
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
  const runId = typeof overrides.runId === 'string' ? overrides.runId : 'agent_run_1'
  const lease: BrowserContinuationLease = Object.freeze({
    binding: exactBinding,
    ownerRunId: runId,
    isCurrent: (candidate: BrowserContinuationBinding) => candidate === exactBinding,
    assertEligible: async () => undefined,
    release: async () => undefined,
  })
  return {
    lease,
    runId,
    binding: exactBinding,
    tabId: 'tab_1',
    navigationEpoch: 4,
    origin,
    intent: '查询工作居住证有效期',
    mode: 'semantic' as const,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function idSequence(): () => string {
  let current = 0
  return () => String(++current).padStart(4, '0')
}

describe('BrowserPageInspector', () => {
  it('fails closed before emitting any partial snapshot for oversized raw trees or locator fan-out', async () => {
    const oversized = new FakeCdpPort(Array.from(
      { length: MAX_BROWSER_INSPECTION_RAW_NODES + 1 },
      (_, index) => node(index + 1, index === 0 ? 'main' : 'statictext', `node ${index}`, {
        ...(index === 0 ? { axNodeId: 'ax_main', parentAxNodeId: undefined } : {}),
      }),
    ))
    const oversizedInspector = new BrowserPageInspector(oversized, { id: idSequence() })
    await expect(oversizedInspector.inspect(input())).rejects.toMatchObject({ code: 'ACTION_LIMIT_EXCEEDED' })

    const fanout = new FakeCdpPort([
      node(10, 'main', '办事详情', { axNodeId: 'ax_main', parentAxNodeId: undefined }),
    ], {
      locatorMatches: [{
        locator: 'role=main',
        backendNodeIds: Array.from({ length: MAX_BROWSER_INSPECTION_LOCATOR_MATCHES + 1 }, (_, index) => index + 1),
      }],
    })
    const fanoutInspector = new BrowserPageInspector(fanout, { id: idSequence() })
    await expect(fanoutInspector.inspect(input())).rejects.toMatchObject({ code: 'ACTION_LIMIT_EXCEEDED' })
  })

  it('bounds hung inspection work and responds immediately to cancellation', async () => {
    const hung = new FakeCdpPort([])
    hung.readAccessibilitySnapshot.mockImplementation(async () => new Promise<BrowserPageReadResult>(() => undefined))
    const deadlineInspector = new BrowserPageInspector(hung, {
      id: idSequence(), inspectionTimeoutMs: 10,
    })
    await expect(deadlineInspector.inspect(input())).rejects.toMatchObject({ code: 'ACTION_LIMIT_EXCEEDED' })

    const cancelled = new FakeCdpPort([])
    cancelled.readAccessibilitySnapshot.mockImplementation(async () => new Promise<BrowserPageReadResult>(() => undefined))
    const controller = new AbortController()
    const cancellationInspector = new BrowserPageInspector(cancelled, { id: idSequence() })
    const pending = cancellationInspector.inspect(input(binding(), { signal: controller.signal }))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
  })

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
      url: origin, capturedAt: '2026-08-22T16:20:00.000Z',
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
    `${origin}/person/alice@example.com`,
    `${origin}/person/alice%40example.com`,
    `${origin}/person/alice%2540example.com`,
    `${origin}/record/deadbeef-dead-4bad-8bad-deadbeefcafe`,
    `${origin}/record/deadbeef%2Ddead%2D4bad%2D8bad%2Ddeadbeefcafe`,
    `${origin}/record/deadbeef%252Ddead%252D4bad%252D8bad%252Ddeadbeefcafe`,
  ])('reduces identity-bearing model URLs to safe origin provenance: %s', async (url) => {
    const port = new FakeCdpPort([
      node(10, 'main', '办理信息', { axNodeId: 'ax_main', parentAxNodeId: undefined }),
    ], { url })
    const inspector = new BrowserPageInspector(port, { id: idSequence() })

    const snapshot = await inspector.inspect(input())

    expect(snapshot.url).toBe(origin)
    expect(JSON.stringify(snapshot)).not.toMatch(/alice|deadbeef|%40|%2540|%2D|%252D/i)
  })

  it('drops filesystem and identity-bearing text without over-redacting Chinese labels or dates', async () => {
    const port = new FakeCdpPort([
      node(10, 'main', '办理信息', { axNodeId: 'ax_main', parentAxNodeId: undefined }),
      node(11, 'statictext', '/Users/alice/private.txt'),
      node(12, 'statictext', 'C:\\Users\\Alice\\private.txt'),
      node(13, 'statictext', 'alice@example.com'),
      node(14, 'statictext', 'deadbeef-dead-4bad-8bad-deadbeefcafe'),
      node(15, 'statictext', 'alice%40example.com'),
      node(16, 'statictext', 'alice%2540example.com'),
      node(17, 'statictext', 'deadbeef%2Ddead%2D4bad%2D8bad%2Ddeadbeefcafe'),
      node(18, 'statictext', 'deadbeef%252Ddead%252D4bad%252D8bad%252Ddeadbeefcafe'),
      node(19, 'textbox', '有效期至', { value: '2028-06-30' }),
      node(20, 'statictext', '北京市政务服务'),
    ], { title: 'file:///Users/alice/private.txt' })
    const inspector = new BrowserPageInspector(port, { id: idSequence() })

    const snapshot = await inspector.inspect(input())
    const serialized = JSON.stringify(snapshot)

    expect(snapshot.title).toBe('')
    expect(snapshot.nodes).toContainEqual(expect.objectContaining({ name: '北京市政务服务' }))
    expect(snapshot.nodes).toContainEqual(expect.objectContaining({ name: '有效期至', value: '2028-06-30' }))
    expect(serialized).not.toMatch(/Users|private\.txt|alice|deadbeef|%40|%2540|%2D|%252D/i)
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

  it('derives policy only from the actual live registry lease binding', async () => {
    const registry = new BrowserContinuationRegistry({
      workspace: {
        acquireContinuation: vi.fn(async () => undefined),
        releaseContinuation: vi.fn(async () => undefined),
        closeContinuation: vi.fn(async () => undefined),
      },
      repository: {
        insert: vi.fn((value) => value),
        terminate: vi.fn(() => undefined),
      },
      id: () => 'binding_1',
      now: () => 1,
    })
    const actualBinding = registry.bind({
      tabId: 'tab_1', userId: 'user_1', conversationId: 'conversation_1',
      chatRunId: 'workflow_chat_run_1', executionId: 'execution_1', workflowId: 'workflow.one',
      workflowVersion: '1.0.0', source: 'installed', securityFingerprint: 'a'.repeat(64),
      permissionMatrix: {
        'browser.open': [`${origin}/*`],
        'browser.click': [`${origin}/*`],
      },
      browserContinuation: { readableRegions: ['role=main'] },
    })
    const actualLease = await registry.acquire(actualBinding.bindingId, {
      userId: 'user_1', conversationId: 'conversation_1', runId: 'agent_run_1',
    })
    const replacementBinding = deepFreeze({
      ...actualBinding,
      permissionMatrix: {
        ...actualBinding.permissionMatrix,
        'browser.fill': [`${origin}/*`],
      },
    })
    const port = new FakeCdpPort([
      node(10, 'main', '表单', { axNodeId: 'ax_main', parentAxNodeId: undefined }),
      node(11, 'textbox', '姓名'),
      node(12, 'button', '查询'),
    ])
    port.page = { ...port.page, locatorMatches: [{ locator: 'role=main', backendNodeIds: [10] }] }
    const inspector = new BrowserPageInspector(port, { id: idSequence() })

    const independentPolicyInput = {
      ...input(actualBinding),
      lease: actualLease,
      binding: replacementBinding,
    }
    const snapshot = await inspector.inspect(independentPolicyInput)
    expect(Object.fromEntries(snapshot.nodes.map((candidate) => [candidate.name, candidate.actions])))
      .toMatchObject({ 姓名: [], 查询: ['click'] })

    const replacementLease = Object.freeze({ ...actualLease, binding: replacementBinding })
    const replacementPolicyInput = {
      ...input(replacementBinding),
      lease: replacementLease,
      binding: replacementBinding,
    }
    await expect(inspector.inspect(replacementPolicyInput)).rejects.toMatchObject({ code: 'PAGE_CHANGED' })
    await actualLease.release()
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
      lease: input(otherBinding).lease, cursor: first.cursor,
    }))).rejects.toMatchObject({ code: 'PAGE_CHANGED' })

    const second = await inspector.inspect(input(binding({ readableRegions: ['role=main'] }), { cursor: first.cursor }))
    expect(second.snapshotId).toBe(first.snapshotId)
    expect(second.nodes[0]?.ref).not.toBe(first.nodes[0]?.ref)
    expect(second.serializedBytes).toBeLessThanOrEqual(128 * 1024)
    await expect(inspector.inspect(input(binding({ readableRegions: ['role=main'] }), { cursor: first.cursor })))
      .rejects.toMatchObject({ code: 'PAGE_CHANGED' })
  })

  it('claims a cursor atomically so concurrent consumers get exactly one page', async () => {
    const port = new FakeCdpPort([
      node(10, 'main', '查询结果', { axNodeId: 'ax_main', parentAxNodeId: undefined }),
      ...Array.from({ length: 620 }, (_, index) => node(100 + index, 'row', `结果 ${index}`)),
    ])
    port.page = { ...port.page, locatorMatches: [{ locator: 'role=main', backendNodeIds: [10] }] }
    const inspector = new BrowserPageInspector(port, { id: idSequence() })
    const first = await inspector.inspect(input(binding({ readableRegions: ['role=main'] })))
    const gate = deferred<BrowserPageReadResult>()
    port.readAccessibilitySnapshot.mockImplementation(async () => gate.promise)

    const competing = [
      inspector.inspect(input(binding({ readableRegions: ['role=main'] }), { cursor: first.cursor })),
      inspector.inspect(input(binding({ readableRegions: ['role=main'] }), { cursor: first.cursor })),
    ]
    gate.resolve(port.page)
    const settled = await Promise.allSettled(competing)

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toMatchObject({ code: 'PAGE_CHANGED' })
    await expect(inspector.inspect(input(binding({ readableRegions: ['role=main'] }), { cursor: first.cursor })))
      .rejects.toMatchObject({ code: 'PAGE_CHANGED' })
  })

  it('consumes a claimed cursor even when the page revalidation fails', async () => {
    const port = new FakeCdpPort([
      node(10, 'main', '查询结果', { axNodeId: 'ax_main', parentAxNodeId: undefined }),
      ...Array.from({ length: 620 }, (_, index) => node(100 + index, 'row', `结果 ${index}`)),
    ])
    port.page = { ...port.page, locatorMatches: [{ locator: 'role=main', backendNodeIds: [10] }] }
    const inspector = new BrowserPageInspector(port, { id: idSequence() })
    const first = await inspector.inspect(input(binding({ readableRegions: ['role=main'] })))
    port.readAccessibilitySnapshot.mockRejectedValueOnce(
      Object.assign(new Error('navigation raced the cursor'), { code: 'PAGE_CHANGED' }),
    )

    await expect(inspector.inspect(input(binding({ readableRegions: ['role=main'] }), { cursor: first.cursor })))
      .rejects.toMatchObject({ code: 'PAGE_CHANGED' })
    await expect(inspector.inspect(input(binding({ readableRegions: ['role=main'] }), { cursor: first.cursor })))
      .rejects.toMatchObject({ code: 'PAGE_CHANGED' })
    expect(port.readAccessibilitySnapshot).toHaveBeenCalledTimes(2)
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

  it('preserves pagination and blocks an ancestor image when protection appears at the raw budget edge', async () => {
    const port = new FakeCdpPort([
      node(10, 'main', '查询结果', { axNodeId: 'ax_main', parentAxNodeId: undefined }),
      node(11, 'img', '结果图', { axNodeId: 'ax_result' }),
      ...Array.from({ length: MAX_BROWSER_INSPECTION_RAW_NODES - 4 }, (_, index) => (
        node(100 + index, 'row', `结果 ${index}`)
      )),
      node(2_100, 'statictext', '末页公开信息'),
      node(2_101, 'textbox', '银行卡支付', { parentAxNodeId: 'ax_result' }),
    ])
    port.page = { ...port.page, locatorMatches: [{ locator: 'role=main', backendNodeIds: [10] }] }
    const inspector = new BrowserPageInspector(port, { id: idSequence() })

    let page = await inspector.inspect(input(binding({ readableRegions: ['role=main'] })))
    const exposedNames = [...page.nodes.map((candidate) => candidate.name)]
    const target = page.nodes.find((candidate) => candidate.name === '结果图')!
    while (page.cursor) {
      page = await inspector.inspect(input(binding({ readableRegions: ['role=main'] }), { cursor: page.cursor }))
      exposedNames.push(...page.nodes.map((candidate) => candidate.name))
    }

    expect(exposedNames).toContain('末页公开信息')
    await expect(inspector.inspect(input(binding({ readableRegions: ['role=main'] }), {
      mode: 'region_image', ref: target.ref, visionSupported: true,
    }))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTROL' })
    expect(port.captureNodeScreenshot).not.toHaveBeenCalled()
  })

  it('invalidates refs on navigation, origin change, tab close, and terminal run cleanup', async () => {
    const port = new FakeCdpPort([
      node(10, 'main', '详情', { axNodeId: 'ax_main', parentAxNodeId: undefined }),
      node(11, 'textbox', '有效期至', { value: '2028-06-30' }),
    ])
    const inspector = new BrowserPageInspector(port, { id: idSequence() })
    const authority = input(binding({ readableRegions: ['role=main'] }))
    const first = await inspector.inspect(authority)
    const target = first.nodes.find((candidate) => candidate.name === '有效期至')!

    await expect(inspector.resolveRef({
      lease: authority.lease, tabId: 'tab_1', snapshotId: first.snapshotId,
      navigationEpoch: 5, origin, ref: target.ref,
    })).rejects.toMatchObject({ code: 'PAGE_CHANGED' })
    await expect(inspector.resolveRef({
      lease: authority.lease, tabId: 'tab_1', snapshotId: first.snapshotId,
      navigationEpoch: 4, origin: 'https://other.example', ref: target.ref,
    })).rejects.toMatchObject({ code: 'PAGE_CHANGED' })

    port.invalidate()
    await expect(inspector.resolveRef({
      lease: authority.lease, tabId: 'tab_1', snapshotId: first.snapshotId,
      navigationEpoch: 4, origin, ref: target.ref,
    })).rejects.toMatchObject({ code: 'PAGE_CHANGED' })

    const nextAuthority = input(binding({ readableRegions: ['role=main'] }))
    const next = await inspector.inspect(nextAuthority)
    inspector.endRun('agent_run_1')
    await expect(inspector.resolveRef({
      lease: nextAuthority.lease, tabId: 'tab_1', snapshotId: next.snapshotId,
      navigationEpoch: 4, origin, ref: next.nodes[0]!.ref,
    })).rejects.toMatchObject({ code: 'PAGE_CHANGED' })
  })

  it('reclassifies live auth and target semantics without exposing Main-only context', async () => {
    const exactBinding = deepFreeze({
      ...binding({
        auth: { loggedOut: ['css=form#login'] },
        readableRegions: ['role=main'],
        manualActions: [{ locator: 'css=#confirm', reason: '人工确认' }],
      }),
      permissionMatrix: {
        'browser.open': [`${origin}/*`],
        'browser.click': [`${origin}/*`],
      },
    })
    const port = new FakeCdpPort([
      node(10, 'main', '申请', { axNodeId: 'ax_main', parentAxNodeId: undefined }),
      node(11, 'form', '申请表单', { axNodeId: 'ax_form' }),
      node(12, 'statictext', '确认并提交申请', { parentAxNodeId: 'ax_form' }),
      node(13, 'button', '保存草稿', {
        parentAxNodeId: 'ax_form', dom: { tagName: 'button', inputType: 'submit' },
      }),
      node(14, 'form', '登录', { axNodeId: 'ax_login' }),
    ])
    port.page = {
      ...port.page,
      locatorMatches: [
        { locator: 'role=main', backendNodeIds: [10] },
        { locator: 'css=form#login', backendNodeIds: [] },
        { locator: 'css=#confirm', backendNodeIds: [13] },
      ],
    }
    const inspector = new BrowserPageInspector(port, { id: idSequence() })
    const authority = input(exactBinding)
    const snapshot = await inspector.inspect(authority)
    const target = snapshot.nodes.find((candidate) => candidate.name === '保存草稿')!
    expect(JSON.stringify(snapshot)).not.toMatch(/targetContext|semanticFingerprint|backendNodeId/u)

    port.page = {
      ...port.page,
      locatorMatches: port.page.locatorMatches.map((entry) => (
        entry.locator === 'css=form#login' ? { ...entry, backendNodeIds: [14] } : entry
      )),
    }
    await expect(inspector.resolveRef({
      lease: authority.lease, tabId: 'tab_1', snapshotId: snapshot.snapshotId,
      navigationEpoch: 4, origin, ref: target.ref,
    })).resolves.toMatchObject({
      auth: 'required',
      semanticFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      targetContext: {
        formOwned: true,
        inputType: 'submit',
        expectedNavigation: true,
        manualAction: true,
        nearbyLabels: expect.arrayContaining(['确认并提交申请']),
      },
    })
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
    {
      kind: 'payment',
      parent: node(11, 'group', '银行卡支付', { axNodeId: 'ax_restricted' }),
      child: node(12, 'img', '银行标志', { parentAxNodeId: 'ax_restricted' }),
    },
    {
      kind: 'authentication',
      parent: node(11, 'textbox', '账户口令', {
        axNodeId: 'ax_restricted', dom: { tagName: 'input', inputType: 'password' },
      }),
      child: node(12, 'img', '账户标志', { parentAxNodeId: 'ax_restricted' }),
    },
  ])('refuses a benign child inside a $kind restricted subtree', async ({ parent, child }) => {
    const port = new FakeCdpPort([
      node(10, 'main', '详情', { axNodeId: 'ax_main', parentAxNodeId: undefined }),
      parent,
      child,
    ])
    const inspector = new BrowserPageInspector(port, { id: idSequence() })
    const snapshot = await inspector.inspect(input(binding({ readableRegions: ['role=main'] })))
    const exposed = snapshot.nodes.find((candidate) => candidate.name === child.name)!

    await expect(inspector.inspect(input(binding({ readableRegions: ['role=main'] }), {
      mode: 'region_image', ref: exposed.ref, visionSupported: true,
    }))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTROL' })
    expect(port.captureNodeScreenshot).not.toHaveBeenCalled()
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
