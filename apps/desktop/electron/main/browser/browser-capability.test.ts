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
  conversationId: 'conversation_1',
  chatRunId: 'chat_run_1',
  workflowId: 'browser.search.baidu',
  workflowVersion: '1.0.0',
  source: 'installed',
  securityFingerprint: 'a'.repeat(64),
  permissionMatrix: {
    'browser.open': ['https://www.baidu.com/*'],
    'browser.click': ['https://www.baidu.com/*'],
  },
  browserContinuation: { readableRegions: ['css=main'] },
}
const baiduScope = { origins: ['https://www.baidu.com'] }

function createHarness() {
  let currentUserId: string | undefined = context.userId
  let currentUrl = 'about:blank'
  const tab: BrowserWorkspaceTab = {
    id: 'tab_1',
    navigationEpoch: 0,
    open: vi.fn(async (url) => { currentUrl = url }),
    fill: vi.fn(async () => undefined),
    click: vi.fn(async () => { currentUrl = 'https://www.baidu.com/s?wd=AutoForge' }),
    url: vi.fn(async () => currentUrl),
    currentOrigin: vi.fn(async () => new URL(currentUrl).origin),
    focus: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  }
  const continuationRegistry = {
    bind: vi.fn((input) => ({ ...input, bindingId: 'binding_1', createdAt: 1, status: 'active' as const })),
  }
  const workspace: BrowserWorkspacePort = {
    acquire: vi.fn(async () => tab),
    releaseExecution: vi.fn(async () => undefined),
    markContinuationBound: vi.fn(),
    setContinuationRegistry: vi.fn(),
    updateProxy: vi.fn(async () => undefined),
    reset: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  }
  const authorize = vi.fn(async () => undefined)
  const service = new BrowserCapabilityService({
    authorization: { authorize },
    workspace,
    currentUserId: () => currentUserId,
    continuationRegistry: continuationRegistry as never,
  })
  return {
    service,
    tab,
    workspace,
    continuationRegistry,
    authorize,
    setUrl: (value: string) => { currentUrl = value },
    setCurrentUser: (value: string | undefined) => { currentUserId = value },
  }
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

  it('authorizes a finite set of exact HTTPS origins as one approved scope', () => {
    const repository = { upsert: vi.fn(), get: vi.fn(), delete: vi.fn() }
    const policy = new PolicyEngine(repository)
    const redirectScope = {
      origins: ['https://fw.bjrcgz.gov.cn', 'https://bjt.beijing.gov.cn'],
    }
    policy.record({
      executionId: context.executionId,
      workflowId: context.workflowId,
      workflowVersion: context.workflowVersion,
      capability: 'browser.open',
      scope: redirectScope,
      decision: 'once',
    })
    const authorization = new PolicyEngineBrowserAuthorization(policy)

    expect(() => authorization.authorize(context, {
      capability: 'browser.open', scope: redirectScope,
    })).not.toThrow()
  })
})

describe('BrowserCapabilityService', () => {
  it('acquires a user-scoped tab and preserves the existing browser workflow contract', async () => {
    const { service, tab, workspace, authorize, continuationRegistry } = createHarness()

    await service.open(context, 'https://www.baidu.com', baiduScope)
    await service.fill(context, 'css=#kw', 'AutoForge', baiduScope)
    await service.click(context, 'role=button[name="百度一下"]', baiduScope)
    await expect(service.url(context, baiduScope)).resolves.toBe('https://www.baidu.com/s?wd=AutoForge')

    expect(workspace.acquire).toHaveBeenCalledWith({
      ...context,
    } satisfies BrowserWorkspaceAcquireInput)
    expect(tab.open).toHaveBeenCalledWith('https://www.baidu.com', ['https://www.baidu.com'])
    expect(tab.fill).toHaveBeenCalledWith('css=#kw', 'AutoForge', 'https://www.baidu.com')
    expect(tab.click).toHaveBeenCalledWith('role=button[name="百度一下"]', 'https://www.baidu.com')
    expect(authorize).toHaveBeenCalledWith(context, {
      capability: 'browser.url', scope: { origins: ['https://www.baidu.com'] },
    })
    expect(continuationRegistry.bind).toHaveBeenCalledWith({ ...context, tabId: tab.id })
    expect(workspace.markContinuationBound).toHaveBeenCalledWith(tab.id)
  })

  it('registers only after a successful Agent-owned browser.open and leaves manual starts unbound', async () => {
    const failed = createHarness()
    vi.mocked(failed.tab.open).mockRejectedValueOnce(new Error('navigation failed'))

    await expect(failed.service.open(context, 'https://www.baidu.com', baiduScope)).rejects.toThrow()
    expect(failed.continuationRegistry.bind).not.toHaveBeenCalled()
    expect(failed.workspace.markContinuationBound).not.toHaveBeenCalled()

    const manual = createHarness()
    const manualContext = { ...context }
    delete manualContext.conversationId
    delete manualContext.chatRunId
    await manual.service.open(manualContext, 'https://www.baidu.com', baiduScope)

    expect(manual.continuationRegistry.bind).not.toHaveBeenCalled()
    expect(manual.workspace.markContinuationBound).not.toHaveBeenCalled()
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

  it('keeps an explicitly approved redirect origin authorized after browser.open', async () => {
    const { service, tab, authorize, setUrl } = createHarness()
    const redirectScope = {
      origins: ['https://fw.bjrcgz.gov.cn', 'https://bjt.beijing.gov.cn'],
    }
    vi.mocked(tab.open).mockImplementationOnce(async () => {
      setUrl('https://bjt.beijing.gov.cn/renzheng/open/login/goUserLogin')
    })

    await service.open(
      context,
      'https://fw.bjrcgz.gov.cn/person-platform/',
      redirectScope,
    )

    expect(tab.open).toHaveBeenCalledWith(
      'https://fw.bjrcgz.gov.cn/person-platform/',
      redirectScope.origins,
    )
    expect(authorize).toHaveBeenLastCalledWith(context, {
      capability: 'browser.open', scope: redirectScope,
    })
  })

  it('allows browser.open to finish on a redirect covered by its declared URL patterns', async () => {
    const { service, tab, setUrl } = createHarness()
    const declaredScope = { origins: ['https://*.bjt.beijing.gov.cn'] }
    const exactScope = { origins: ['https://fw.bjrcgz.gov.cn'] }
    const redirectContext: BrowserCapabilityContext = {
      ...context,
      permissionMatrix: { 'browser.open': declaredScope.origins },
    }
    vi.mocked(tab.open).mockImplementationOnce(async () => {
      setUrl('https://portal.bjt.beijing.gov.cn/p/login/login.html')
    })

    await expect(service.request(redirectContext, {
      capability: 'browser.open',
      scope: exactScope,
      arguments: { url: 'https://fw.bjrcgz.gov.cn/person-platform/' },
    }, declaredScope)).resolves.toBeUndefined()

    expect(tab.open).toHaveBeenCalledWith(
      'https://fw.bjrcgz.gov.cn/person-platform/',
      exactScope.origins,
      declaredScope.origins,
    )
  })

  it('rejects a browser.open redirect outside its declared URL patterns', async () => {
    const { service, tab, setUrl } = createHarness()
    const declaredScope = { origins: ['https://*.bjt.beijing.gov.cn/login/*'] }
    vi.mocked(tab.open).mockImplementationOnce(async () => {
      setUrl('https://portal.bjt.beijing.gov.cn/admin/')
    })

    await expect(service.request(context, {
      capability: 'browser.open',
      scope: { origins: ['https://fw.bjrcgz.gov.cn'] },
      arguments: { url: 'https://fw.bjrcgz.gov.cn/person-platform/' },
    }, declaredScope)).rejects.toMatchObject({ code: 'CAPABILITY_SCOPE_DENIED' })
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
      id: 'tab_delayed', navigationEpoch: 0,
      open: vi.fn(), fill: vi.fn(), click: vi.fn(), url: vi.fn(),
      currentOrigin: vi.fn(), focus: vi.fn(), close: vi.fn(),
    }
    const workspace: BrowserWorkspacePort = {
      acquire: vi.fn(() => new Promise<BrowserWorkspaceTab>((resolve) => { resolveAcquire = resolve })),
      releaseExecution: vi.fn(), updateProxy: vi.fn(), reset: vi.fn(), shutdown: vi.fn(),
    }
    const service = new BrowserCapabilityService({
      authorization: { authorize: vi.fn() }, workspace, currentUserId: () => context.userId,
    })

    const opening = service.open(context, 'https://www.baidu.com', baiduScope)
    while (!resolveAcquire) await Promise.resolve()
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

  it('rejects an old-user execution that first requests a browser after the account switch', async () => {
    const { service, workspace, setCurrentUser } = createHarness()

    setCurrentUser('user_2')
    await service.reset()

    await expect(service.open(context, 'https://www.baidu.com', baiduScope))
      .rejects.toMatchObject({ code: 'CANCELLED' })
    expect(workspace.acquire).not.toHaveBeenCalled()
  })
})
