import { describe, expect, it } from 'vitest'
import {
  BrowserActionGuard,
  requiredCapability,
  type BrowserActionGuardContext,
} from './browser-action-guard.js'
import type { BrowserAction, BrowserSemanticNode } from './browser-continuation-types.js'

function node(
  role: string,
  name: string,
  overrides: Partial<BrowserSemanticNode> = {},
): BrowserSemanticNode {
  return {
    ref: `ref_${name}`,
    role,
    name,
    enabled: true,
    actions: role === 'textbox' ? ['fill'] : ['click'],
    ...overrides,
  }
}

function context(overrides: Partial<BrowserActionGuardContext> = {}): BrowserActionGuardContext {
  return {
    origin: 'https://service.example',
    url: 'https://service.example/draft',
    action: { type: 'click', ref: 'ref_save' },
    target: node('button', '保存草稿', { ref: 'ref_save' }),
    auth: 'authenticated',
    snapshotFresh: true,
    permissionMatrix: {
      'browser.open': ['https://service.example/*'],
      'browser.fill': ['https://service.example/*'],
      'browser.click': ['https://service.example/*'],
    },
    ...overrides,
  }
}

describe('BrowserActionGuard', () => {
  const guard = new BrowserActionGuard()

  it.each([
    node('button', '正式提交'),
    node('button', '确认变更'),
    node('button', '支付'),
    node('button', '删除'),
    node('button', '撤回'),
    node('button', '退出登录'),
    node('button', '立即发布'),
  ])('hands protected actions to the user: $name', (target) => {
    expect(guard.decide(context({ action: { type: 'click', ref: target.ref }, target })))
      .toEqual({ kind: 'handoff', code: 'MANUAL_ACTION_REQUIRED' })
  })

  it('does not combine open origin A with click origin B', () => {
    expect(guard.decide(context({
      origin: 'https://a.example',
      url: 'https://a.example/page',
      action: { type: 'click', ref: 'ref_1' },
      target: node('button', '搜索', { ref: 'ref_1' }),
      permissionMatrix: {
        'browser.open': ['https://a.example/*'],
        'browser.click': ['https://b.example/*'],
      },
    }))).toEqual({ kind: 'blocked', code: 'DOMAIN_BLOCKED' })
  })

  it.each([
    [{ type: 'click', ref: 'ref_save' }, node('button', '保存草稿', { ref: 'ref_save' })],
    [{ type: 'click', ref: 'ref_search' }, node('button', '搜索', { ref: 'ref_search' })],
    [{ type: 'click', ref: 'ref_next_page' }, node('button', '下一页', { ref: 'ref_next_page' })],
    [{ type: 'click', ref: 'ref_tab' }, node('tab', '办理进度', { ref: 'ref_tab' })],
  ] as const)('allows demonstrably reversible action %#', (action, target) => {
    expect(guard.decide(context({ action, target }))).toEqual({ kind: 'allowed' })
  })

  it('hands ambiguous next-step controls off when form semantics imply submission', () => {
    const target = node('button', '下一步', { ref: 'ref_next' })
    expect(guard.decide(context({
      action: { type: 'click', ref: target.ref },
      target,
      targetContext: { formOwned: true, expectedNavigation: true, nearbyLabels: ['确认申请信息'] },
    }))).toEqual({ kind: 'handoff', code: 'MANUAL_ACTION_REQUIRED' })
  })

  it('fails stale and unsupported target semantics closed', () => {
    expect(guard.decide(context({ snapshotFresh: false })))
      .toEqual({ kind: 'blocked', code: 'PAGE_CHANGED' })
    expect(guard.decide(context({
      action: { type: 'click', ref: 'ref_text' },
      target: node('textbox', '说明', { ref: 'ref_text', actions: ['fill'] }),
    }))).toEqual({ kind: 'blocked', code: 'UNSUPPORTED_CONTROL' })
  })

  it.each([
    [node('button', '登录'), { formOwned: true, inputType: 'password' }, 'AUTH_REQUIRED'],
    [node('textbox', '上传附件', { actions: [] }), { inputType: 'file' }, 'UNSUPPORTED_CONTROL'],
    [node('button', '手写签名'), { nearbyLabels: ['签署承诺书'] }, 'MANUAL_ACTION_REQUIRED'],
    [node('button', '银行卡付款'), { nearbyLabels: ['支付订单'] }, 'MANUAL_ACTION_REQUIRED'],
  ] as const)('hands login/file/signature/payment controls off: %#', (target, targetContext, code) => {
    const action: BrowserAction = target.role === 'textbox'
      ? { type: 'fill', ref: target.ref, value: 'x', source: { kind: 'current_user' } }
      : { type: 'click', ref: target.ref }
    expect(guard.decide(context({ action, target, targetContext })))
      .toEqual({ kind: 'handoff', code })
  })

  it('never dispatches a disabled control even if stale action metadata advertises click', () => {
    expect(guard.decide(context({
      target: node('button', '保存草稿', { ref: 'ref_save', enabled: false, actions: ['click'] }),
    }))).toEqual({ kind: 'blocked', code: 'UNSUPPORTED_CONTROL' })
  })

  it('honors exact declared manual role locators and fails unresolved CSS manual locators closed', () => {
    const target = node('button', '保存草稿', { ref: 'ref_save' })
    expect(guard.decide(context({
      target,
      browserContinuation: { manualActions: [{ locator: 'role=button[name="保存草稿"]', reason: '人工复核' }] },
    }))).toEqual({ kind: 'handoff', code: 'MANUAL_ACTION_REQUIRED' })
    expect(guard.decide(context({
      target,
      browserContinuation: { manualActions: [{ locator: 'css=#manual-save', reason: '人工复核' }] },
    }))).toEqual({ kind: 'handoff', code: 'MANUAL_ACTION_REQUIRED' })
  })

  it('requires union inspection scope even for capability-less actions', () => {
    expect(guard.decide(context({
      origin: 'https://outside.example',
      url: 'https://outside.example/page',
      action: { type: 'wait', milliseconds: 50 },
    }))).toEqual({ kind: 'blocked', code: 'DOMAIN_BLOCKED' })
  })

  it('maps actions to only their exact originating capability', () => {
    expect(requiredCapability({ type: 'fill', ref: 'r', value: 'v', source: { kind: 'current_user' } }))
      .toBe('browser.fill')
    expect(requiredCapability({ type: 'select', ref: 'r', value: 'v', source: { kind: 'current_user' } }))
      .toBe('browser.fill')
    expect(requiredCapability({ type: 'click', ref: 'r' })).toBe('browser.click')
    expect(requiredCapability({ type: 'check', ref: 'r', checked: true, source: { kind: 'current_user' } }))
      .toBe('browser.click')
    expect(requiredCapability({ type: 'navigate', url: 'https://service.example/next' })).toBe('browser.open')
    expect(requiredCapability({ type: 'scroll', direction: 'down' })).toBeUndefined()
    expect(requiredCapability({ type: 'wait', milliseconds: 50 })).toBeUndefined()
    expect(requiredCapability({ type: 'focus' })).toBeUndefined()
  })
})
