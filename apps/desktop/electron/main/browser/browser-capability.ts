import {
  matchesHttpsUrlPattern,
  toSafeAppError,
  type AppError,
  type AppErrorCode,
  type Capability,
  type CapabilityScope,
  type WorkerCapabilityRequest,
} from '@autoforge/shared'
import type { PolicyEngine } from '../permissions/policy-engine.js'
import type { CapabilityContext, CapabilityPort } from '../workflows/execution-service.js'
import { canonicalJson } from '../workflows/workflow-security-fingerprint.js'
import type { BrowserContinuationRegistry } from './browser-continuation-registry.js'
import type { BrowserContinuationBindingInput } from './browser-continuation-types.js'
import type { BrowserWorkspacePort, BrowserWorkspaceTab } from './electron-browser-workspace.js'

type BrowserCapability = Extract<Capability, `browser.${string}`>
type BrowserScope = Extract<CapabilityScope, { origins: string[] }>

export type BrowserCapabilityContext = CapabilityContext

export interface BrowserAuthorizationRequest {
  capability: BrowserCapability
  scope: BrowserScope
}

export interface BrowserAuthorizationPort {
  authorize(
    context: BrowserCapabilityContext,
    request: BrowserAuthorizationRequest,
  ): Promise<void> | void
}

export interface BrowserCapabilityServiceOptions {
  authorization: BrowserAuthorizationPort
  workspace: BrowserWorkspacePort
  currentUserId(): Promise<string | undefined> | string | undefined
  continuationRegistry?: BrowserContinuationRegistry
}

interface ExecutionBrowserState {
  context: BrowserCapabilityContext
  tab?: BrowserWorkspaceTab
  creation?: Promise<BrowserWorkspaceTab>
  released: boolean
}

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

function exactBrowserScope(scope: CapabilityScope | undefined): BrowserScope {
  const origins = scope && 'origins' in scope ? scope.origins : undefined
  if (!scope
    || !origins
    || origins.length < 1
    || new Set(origins).size !== origins.length) {
    throw failure('CAPABILITY_SCOPE_DENIED')
  }
  try {
    if (origins.some((origin) => originOf(origin) !== origin)) {
      throw failure('CAPABILITY_SCOPE_DENIED')
    }
  } catch {
    throw failure('CAPABILITY_SCOPE_DENIED')
  }
  return { origins }
}

function assertExactScope(scope: CapabilityScope | undefined, origin: string): BrowserScope {
  const exactScope = exactBrowserScope(scope)
  if (!exactScope.origins.includes(origin)) throw failure('CAPABILITY_SCOPE_DENIED')
  return exactScope
}

function sameContext(left: BrowserCapabilityContext, right: BrowserCapabilityContext): boolean {
  try { return canonicalJson(left) === canonicalJson(right) }
  catch { return false }
}

export class PolicyEngineBrowserAuthorization implements BrowserAuthorizationPort {
  constructor(private readonly policy: Pick<PolicyEngine, 'evaluate'>) {}

  authorize(context: BrowserCapabilityContext, request: BrowserAuthorizationRequest): void {
    exactBrowserScope(request.scope)
    const evaluation = this.policy.evaluate({
      executionId: context.executionId,
      workflowId: context.workflowId,
      workflowVersion: context.workflowVersion,
      capability: request.capability,
      scope: request.scope,
    })
    if (!evaluation.allowed) throw failure('CAPABILITY_SCOPE_DENIED')
  }
}

export class BrowserCapabilityService implements CapabilityPort {
  private readonly executions = new Map<string, ExecutionBrowserState>()
  private readonly invalidatedExecutions = new Set<string>()
  private identityEpoch = 0
  private stopped = false

  constructor(private readonly options: BrowserCapabilityServiceOptions) {
    if (options.continuationRegistry) {
      options.workspace.setContinuationRegistry?.(options.continuationRegistry)
    }
  }

  hasActiveContexts(): boolean {
    return this.executions.size > 0
  }

  async request(
    context: BrowserCapabilityContext,
    request: WorkerCapabilityRequest,
    declaredScope?: CapabilityScope,
  ): Promise<unknown> {
    switch (request.capability) {
      case 'browser.open':
        return this.open(context, request.arguments.url, request.scope, declaredScope)
      case 'browser.fill':
        return this.fill(context, request.arguments.locator, request.arguments.value, request.scope)
      case 'browser.click':
        return this.click(context, request.arguments.locator, request.scope)
      case 'browser.url':
        return this.url(context, request.scope)
      case 'browser.close':
        return this.close(context, request.scope)
    }
  }

  async open(
    context: BrowserCapabilityContext,
    url: string,
    requestedScope?: CapabilityScope,
    declaredScope?: CapabilityScope,
  ): Promise<void> {
    const state = await this.stateForCurrentUser(context, true)
    const origin = originOf(url)
    const authorizedScope = await this.authorize(context, 'browser.open', requestedScope, origin)
    const declaredPatterns = declaredScope && 'origins' in declaredScope
      ? declaredScope.origins
      : undefined
    this.assertActive(state)
    const tab = await this.ensureTab(state)
    this.assertActive(state)
    if (declaredPatterns) {
      await tab.open(url, authorizedScope.origins, declaredPatterns)
    } else {
      await tab.open(url, authorizedScope.origins)
    }
    const currentUrl = await tab.url()
    const currentOrigin = originOf(currentUrl)
    if (authorizedScope.origins.includes(currentOrigin)) {
      await this.authorizeCurrent(state, 'browser.open', requestedScope)
    } else if (!declaredPatterns?.some((pattern) => matchesHttpsUrlPattern(pattern, currentUrl))) {
      throw failure('CAPABILITY_SCOPE_DENIED')
    }
    const binding = this.bindingInput(state.context, tab.id)
    if (binding && this.options.continuationRegistry) {
      this.options.continuationRegistry.bind(binding)
      this.options.workspace.markContinuationBound?.(tab.id)
    }
  }

  async fill(
    context: BrowserCapabilityContext,
    locator: string,
    value: string,
    declaredScope?: CapabilityScope,
  ): Promise<void> {
    const state = await this.stateForCurrentUser(context, false)
    const tab = this.tab(state)
    const origin = await this.authorizeCurrent(state, 'browser.fill', declaredScope)
    this.assertActive(state)
    await tab.fill(locator, value, origin)
    await this.authorizeCurrent(state, 'browser.fill', declaredScope)
  }

  async click(
    context: BrowserCapabilityContext,
    locator: string,
    declaredScope?: CapabilityScope,
  ): Promise<void> {
    const state = await this.stateForCurrentUser(context, false)
    const tab = this.tab(state)
    const origin = await this.authorizeCurrent(state, 'browser.click', declaredScope)
    this.assertActive(state)
    await tab.click(locator, origin)
    await this.authorizeCurrent(state, 'browser.click', declaredScope)
  }

  async url(context: BrowserCapabilityContext, declaredScope?: CapabilityScope): Promise<string> {
    const state = await this.stateForCurrentUser(context, false)
    const tab = this.tab(state)
    await this.authorizeCurrent(state, 'browser.url', declaredScope)
    this.assertActive(state)
    const value = await tab.url()
    this.assertActive(state)
    return value
  }

  async close(context: BrowserCapabilityContext, declaredScope?: CapabilityScope): Promise<void> {
    const state = await this.stateForCurrentUser(context, false)
    const tab = this.tab(state)
    await this.authorizeCurrent(state, 'browser.close', declaredScope)
    state.released = true
    this.executions.delete(context.executionId)
    try {
      await tab.close()
    } finally {
      await this.options.workspace.releaseExecution(context.executionId)
    }
  }

  async closeExecution(executionId: string): Promise<void> {
    const state = this.executions.get(executionId)
    if (!state) {
      this.invalidatedExecutions.delete(executionId)
      return
    }
    state.released = true
    this.executions.delete(executionId)
    await this.options.workspace.releaseExecution(executionId)
  }

  updateProxy(): Promise<void> {
    return this.options.workspace.updateProxy()
  }

  async reset(): Promise<void> {
    this.identityEpoch += 1
    const states = [...this.executions.values()]
    this.executions.clear()
    for (const state of states) {
      state.released = true
      this.invalidatedExecutions.add(state.context.executionId)
    }
    for (const state of states) await this.options.workspace.releaseExecution(state.context.executionId)
    await this.options.workspace.reset()
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    await this.reset()
    await this.options.workspace.shutdown()
    this.invalidatedExecutions.clear()
  }

  private state(context: BrowserCapabilityContext, create: boolean): ExecutionBrowserState {
    if (this.stopped) throw failure('CONFLICT')
    if (this.invalidatedExecutions.has(context.executionId)) throw failure('CANCELLED')
    const existing = this.executions.get(context.executionId)
    if (existing) {
      if (!sameContext(existing.context, context)) throw failure('CAPABILITY_SCOPE_DENIED')
      this.assertActive(existing)
      return existing
    }
    if (!create) throw failure('NOT_FOUND')
    const state: ExecutionBrowserState = { context: { ...context }, released: false }
    this.executions.set(context.executionId, state)
    return state
  }

  private async stateForCurrentUser(
    context: BrowserCapabilityContext,
    create: boolean,
  ): Promise<ExecutionBrowserState> {
    const epoch = this.identityEpoch
    const currentUserId = await this.options.currentUserId()
    if (currentUserId !== context.userId || epoch !== this.identityEpoch) throw failure('CANCELLED')
    return this.state(context, create)
  }

  private tab(state: ExecutionBrowserState): BrowserWorkspaceTab {
    this.assertActive(state)
    if (!state.tab) throw failure('NOT_FOUND')
    return state.tab
  }

  private ensureTab(state: ExecutionBrowserState): Promise<BrowserWorkspaceTab> {
    if (state.tab) return Promise.resolve(state.tab)
    if (state.creation) return state.creation
    const creation = this.options.workspace.acquire({
      ...state.context,
    }).then(async (tab) => {
      if (state.released || this.executions.get(state.context.executionId) !== state) {
        await this.options.workspace.releaseExecution(state.context.executionId)
        throw failure('CANCELLED')
      }
      state.tab = tab
      return tab
    }).finally(() => {
      if (state.creation === creation) state.creation = undefined
    })
    state.creation = creation
    return creation
  }

  private authorize(
    context: BrowserCapabilityContext,
    capability: BrowserCapability,
    declaredScope: CapabilityScope | undefined,
    origin: string,
  ): Promise<BrowserScope> {
    const scope = assertExactScope(declaredScope, origin)
    return Promise.resolve(this.options.authorization.authorize(context, {
      capability,
      scope,
    })).then(() => scope)
  }

  private async authorizeCurrent(
    state: ExecutionBrowserState,
    capability: BrowserCapability,
    declaredScope: CapabilityScope | undefined,
  ): Promise<string> {
    this.assertActive(state)
    const origin = originOf(await this.tab(state).url())
    await this.authorize(state.context, capability, declaredScope, origin)
    this.assertActive(state)
    return origin
  }

  private assertActive(state: ExecutionBrowserState): void {
    if (state.released || this.executions.get(state.context.executionId) !== state) throw failure('CANCELLED')
  }

  private bindingInput(
    context: BrowserCapabilityContext,
    tabId: string,
  ): BrowserContinuationBindingInput | undefined {
    if (!context.conversationId || !context.chatRunId) return undefined
    return {
      tabId,
      userId: context.userId,
      conversationId: context.conversationId,
      chatRunId: context.chatRunId,
      executionId: context.executionId,
      workflowId: context.workflowId,
      workflowVersion: context.workflowVersion,
      source: context.source,
      ...(context.buildHash === undefined ? {} : { buildHash: context.buildHash }),
      securityFingerprint: context.securityFingerprint,
      permissionMatrix: context.permissionMatrix,
      ...(context.browserContinuation === undefined
        ? {}
        : { browserContinuation: context.browserContinuation }),
    }
  }
}
