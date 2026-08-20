import { describe, expect, it, vi } from 'vitest'
import { PolicyEngine } from '../permissions/policy-engine.js'
import {
  BrowserCapabilityService,
  PolicyEngineBrowserAuthorization,
  type BrowserCapabilityContext,
} from './browser-capability.js'
import type {
  BrowserWorkspaceAcquireInput,
  BrowserWorkspacePort,
  BrowserWorkspaceTab,
} from './electron-browser-workspace.js'

const context: BrowserCapabilityContext = {
  executionId: 'exec_1',
  userId: 'user_1',
  workflowId: 'browser.search.baidu',
  workflowVersion: '1.0.0',
}
const baiduScope = { origins: ['https://www.baidu.com'] }

function createHarness() {
  let currentUrl = 'about:blank'
  const tab: BrowserWorkspaceTab = {
    open: vi.fn(async (url) => { currentUrl = url }),
    fill: vi.fn(async () => undefined),
    click: vi.fn(async () => { currentUrl = 'https://www.baidu.com/s?wd=AutoForge' }),
    url: vi.fn(async () => currentUrl),
    close: vi.fn(async () => undefined),
  }
  const workspace: BrowserWorkspacePort = {
    acquire: vi.fn(async () => tab),
    releaseExecution: vi.fn(async () => undefined),
    updateProxy: vi.fn(async () => undefined),
    reset: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  }
  const authorize = vi.fn(async () => undefined)
  const service = new BrowserCapabilityService({ authorization: { authorize }, workspace })
  return { service, tab, workspace, authorize, setUrl: (value: string) => { currentUrl = value } }
}

describe('PolicyEngineBrowserAuthorization', () => {
  it('accepts only exact HTTPS origins granted by policy', () => {
    const repository = { upsert: vi.fn(), get: vi.fn(), delete: vi.fn() }
    const policy = new PolicyEngine(repository)
    policy.record({
      executionId: context.executionId,
      workflowId: context.workflowId,
      workflowVersion: context.workflowVersion,
      capability: 'browser.open',
      scope: baiduScope,
      decision: 'once',
    })
    const authorization = new PolicyEngineBrowserAuthorization(policy)

    expect(() => authorization.authorize(context, { capability: 'browser.open', scope: baiduScope })).not.toThrow()
    expect(() => authorization.authorize(context, {
      capability: 'browser.open', scope: { origins: ['http://www.baidu.com'] },
    })).toThrow(expect.objectContaining({ code: 'CAPABILITY_SCOPE_DENIED' }))
    expect(() => authorization.authorize(context, {
      capability: 'browser.open', scope: { origins: ['https://example.com'] },
    })).toThrow(expect.objectContaining({ code: 'CAPABILITY_SCOPE_DENIED' }))
  })
})

describe('BrowserCapabilityService', () => {
  it('acquires a user-scoped tab and preserves the existing browser workflow contract', async () => {
    const { service, tab, workspace, authorize } = createHarness()

    await service.open(context, 'https://www.baidu.com', baiduScope)
    await service.fill(context, 'css=#kw', 'AutoForge', baiduScope)
    await service.click(context, 'role=button[name="百度一下"]', baiduScope)
    await expect(service.url(context, baiduScope)).resolves.toBe('https://www.baidu.com/s?wd=AutoForge')

    expect(workspace.acquire).toHaveBeenCalledWith({
      executionId: context.executionId,
      userId: context.userId,
      workflowId: context.workflowId,
    } satisfies BrowserWorkspaceAcquireInput)
    expect(tab.open).toHaveBeenCalledWith('https://www.baidu.com', 'https://www.baidu.com')
    expect(tab.fill).toHaveBeenCalledWith('css=#kw', 'AutoForge', 'https://www.baidu.com')
    expect(tab.click).toHaveBeenCalledWith('role=button[name="百度一下"]', 'https://www.baidu.com')
    expect(authorize).toHaveBeenCalledWith(context, {
      capability: 'browser.url', scope: { origins: ['https://www.baidu.com'] },
    })
  })

  it('rejects mismatched declared scopes and post-operation cross-origin navigation', async () => {
    const { service, setUrl } = createHarness()

    await expect(service.open(context, 'https://www.baidu.com', { origins: ['https://example.com'] }))
      .rejects.toMatchObject({ code: 'CAPABILITY_SCOPE_DENIED' })
    await service.open(context, 'https://www.baidu.com', baiduScope)
    setUrl('https://example.com/')
    await expect(service.fill(context, 'css=#kw', 'AutoForge', baiduScope))
      .rejects.toMatchObject({ code: 'CAPABILITY_SCOPE_DENIED' })
  })

  it('releases execution ownership without closing the retained tab', async () => {
    const { service, tab, workspace } = createHarness()
    await service.open(context, 'https://www.baidu.com', baiduScope)

    await service.closeExecution(context.executionId)

    expect(workspace.releaseExecution).toHaveBeenCalledWith(context.executionId)
    expect(tab.close).not.toHaveBeenCalled()
    expect(service.hasActiveContexts()).toBe(false)
  })

  it('honors an explicit browser.close and then releases ownership', async () => {
    const { service, tab, workspace } = createHarness()
    await service.open(context, 'https://www.baidu.com', baiduScope)

    await service.close(context, baiduScope)

    expect(tab.close).toHaveBeenCalledOnce()
    expect(workspace.releaseExecution).toHaveBeenCalledWith(context.executionId)
    await expect(service.url(context, baiduScope)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('forwards worker requests and browser workspace lifecycle operations', async () => {
    const { service, workspace } = createHarness()
    await service.request(context, {
      capability: 'browser.open', scope: baiduScope,
      arguments: { url: 'https://www.baidu.com' },
    })
    expect(service.hasActiveContexts()).toBe(true)

    await service.updateProxy()
    await service.shutdown()

    expect(workspace.updateProxy).toHaveBeenCalledOnce()
    expect(workspace.reset).toHaveBeenCalledOnce()
    expect(workspace.releaseExecution).toHaveBeenCalledWith(context.executionId)
    expect(workspace.shutdown).toHaveBeenCalledOnce()
    expect(service.hasActiveContexts()).toBe(false)
  })

  it('cancels an acquire that finishes after terminal cleanup', async () => {
    let resolveAcquire!: (tab: BrowserWorkspaceTab) => void
    const tab: BrowserWorkspaceTab = {
      open: vi.fn(), fill: vi.fn(), click: vi.fn(), url: vi.fn(), close: vi.fn(),
    }
    const workspace: BrowserWorkspacePort = {
      acquire: vi.fn(() => new Promise<BrowserWorkspaceTab>((resolve) => { resolveAcquire = resolve })),
      releaseExecution: vi.fn(), updateProxy: vi.fn(), reset: vi.fn(), shutdown: vi.fn(),
    }
    const service = new BrowserCapabilityService({ authorization: { authorize: vi.fn() }, workspace })

    const opening = service.open(context, 'https://www.baidu.com', baiduScope)
    await Promise.resolve()
    await service.closeExecution(context.executionId)
    resolveAcquire(tab)

    await expect(opening).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(tab.open).not.toHaveBeenCalled()
    expect(workspace.releaseExecution).toHaveBeenCalledWith(context.executionId)
  })

  it('does not let an execution invalidated by an account switch reopen its old user partition', async () => {
    const { service, workspace } = createHarness()
    await service.open(context, 'https://www.baidu.com', baiduScope)

    await service.reset()

    await expect(service.open(context, 'https://www.baidu.com', baiduScope))
      .rejects.toMatchObject({ code: 'CANCELLED' })
    expect(workspace.acquire).toHaveBeenCalledOnce()
    await service.closeExecution(context.executionId)
  })
})
