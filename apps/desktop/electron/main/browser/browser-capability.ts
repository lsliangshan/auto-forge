import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  chromium,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
  type Request,
  type Route,
} from 'playwright-chromium'
import {
  toSafeAppError,
  type AppError,
  type AppErrorCode,
  type Capability,
  type CapabilityScope,
  type WorkerCapabilityRequest,
} from '@autoforge/shared'
import type { PolicyEngine } from '../permissions/policy-engine.js'
import type { CapabilityContext, CapabilityPort } from '../workflows/execution-service.js'

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

export interface BrowserProfileDirectories {
  create(): Promise<string>
  remove(path: string): Promise<void>
}

interface BrowserLauncher {
  executablePath(): string
  launchPersistentContext(
    userDataDirectory: string,
    options: { headless: boolean; executablePath: string; serviceWorkers: 'block' },
  ): Promise<BrowserContext>
}

export interface BrowserRuntimeOptions {
  packaged: boolean
  resourcesPath?: string
  developmentExecutablePath?: string
}

interface BrowserRuntimeManifest {
  version: 1
  executablePath: string
}

export interface BrowserCapabilityServiceOptions {
  authorization: BrowserAuthorizationPort
  headless?: boolean
  launcher?: BrowserLauncher
  profileDirectories?: BrowserProfileDirectories
  runtime?: Omit<BrowserRuntimeOptions, 'developmentExecutablePath'>
}

interface OwnedBrowser {
  context: BrowserContext
  primaryPage: Page
  pages: Set<Page>
  profilePath: string
  contextOpen: boolean
  pendingGuards: Set<Promise<void>>
  routedFrames: WeakSet<Frame>
  redirectedUrls: Map<string, string>
}

interface ActiveBrowserOperation {
  context: BrowserCapabilityContext
  capability: BrowserCapability
  declaredScope?: CapabilityScope
}

interface ExecutionBrowserState {
  executionId: string
  owner?: OwnedBrowser
  profilePath?: string
  creation?: Promise<OwnedBrowser>
  operation?: ActiveBrowserOperation
  violation?: AppError
  closing: boolean
  activeOperations: number
  idleWaiters: Set<() => void>
  closePromise?: Promise<void>
}

const roles = new Set([
  'alert',
  'alertdialog',
  'application',
  'article',
  'banner',
  'blockquote',
  'button',
  'caption',
  'cell',
  'checkbox',
  'code',
  'columnheader',
  'combobox',
  'complementary',
  'contentinfo',
  'definition',
  'deletion',
  'dialog',
  'directory',
  'document',
  'emphasis',
  'feed',
  'figure',
  'form',
  'generic',
  'grid',
  'gridcell',
  'group',
  'heading',
  'img',
  'insertion',
  'link',
  'list',
  'listbox',
  'listitem',
  'log',
  'main',
  'marquee',
  'math',
  'meter',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'navigation',
  'none',
  'note',
  'option',
  'paragraph',
  'presentation',
  'progressbar',
  'radio',
  'radiogroup',
  'region',
  'row',
  'rowgroup',
  'rowheader',
  'scrollbar',
  'search',
  'searchbox',
  'separator',
  'slider',
  'spinbutton',
  'status',
  'strong',
  'subscript',
  'superscript',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'term',
  'textbox',
  'time',
  'timer',
  'toolbar',
  'tooltip',
  'tree',
  'treegrid',
  'treeitem',
])

function failure(code: AppErrorCode): AppError {
  return toSafeAppError({ code })
}

function originOf(value: string): string {
  try {
    return new URL(value).origin
  } catch {
    throw failure('INVALID_INPUT')
  }
}

function browserScope(origin: string): BrowserScope {
  return { origins: [origin] }
}

function assertExactScope(scope: CapabilityScope, origin: string): asserts scope is BrowserScope {
  if (!('origins' in scope)
    || scope.origins.length !== 1
    || scope.origins[0] !== origin
    || originOf(scope.origins[0]) !== scope.origins[0]) {
    throw failure('CAPABILITY_SCOPE_DENIED')
  }
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function parseRuntimeManifest(value: unknown): BrowserRuntimeManifest {
  if (!value || typeof value !== 'object') throw failure('INTERNAL_ERROR')
  const manifest = value as Partial<BrowserRuntimeManifest>
  if (manifest.version !== 1
    || typeof manifest.executablePath !== 'string'
    || manifest.executablePath.length === 0
    || manifest.executablePath.includes('\\')
    || isAbsolute(manifest.executablePath)) {
    throw failure('INTERNAL_ERROR')
  }
  return manifest as BrowserRuntimeManifest
}

async function existingFile(path: string): Promise<string> {
  try {
    const metadata = await lstat(path)
    if (!metadata.isFile()) throw failure('INTERNAL_ERROR')
    return path
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: unknown }).code === 'INTERNAL_ERROR') throw error
    throw failure('INTERNAL_ERROR')
  }
}

export async function resolveBrowserExecutablePath(options: BrowserRuntimeOptions): Promise<string> {
  if (!options.packaged) {
    if (!options.developmentExecutablePath) throw failure('INTERNAL_ERROR')
    return existingFile(options.developmentExecutablePath)
  }
  if (!options.resourcesPath) throw failure('INTERNAL_ERROR')

  try {
    const canonicalResources = await realpath(options.resourcesPath)
    const raw = await readFile(join(canonicalResources, 'browser-runtime.json'), 'utf8')
    const manifest = parseRuntimeManifest(JSON.parse(raw) as unknown)
    const candidate = resolve(canonicalResources, ...manifest.executablePath.split('/'))
    if (!inside(canonicalResources, candidate)) throw failure('INTERNAL_ERROR')
    const canonicalExecutable = await realpath(await existingFile(candidate))
    if (!inside(canonicalResources, canonicalExecutable)) throw failure('INTERNAL_ERROR')
    return canonicalExecutable
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: unknown }).code === 'INTERNAL_ERROR') throw error
    throw failure('INTERNAL_ERROR')
  }
}

export class PolicyEngineBrowserAuthorization implements BrowserAuthorizationPort {
  constructor(private readonly policy: Pick<PolicyEngine, 'evaluate'>) {}

  authorize(context: BrowserCapabilityContext, request: BrowserAuthorizationRequest): void {
    if (request.scope.origins.length !== 1) throw failure('CAPABILITY_SCOPE_DENIED')
    const origin = request.scope.origins[0]
    try {
      const url = new URL(origin)
      if (url.protocol !== 'https:' || url.origin !== origin) throw failure('CAPABILITY_SCOPE_DENIED')
    } catch {
      throw failure('CAPABILITY_SCOPE_DENIED')
    }

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

function locatorFor(page: Page, request: string): Locator {
  if (request.startsWith('css=')) {
    const selector = request.slice(4)
    if (!selector || selector.includes('>>')) throw failure('INVALID_INPUT')
    return page.locator(`css=${selector}`)
  }

  const role = /^role=([a-z]+)(?:\[name=("(?:[^"\\]|\\.)*")\])?$/.exec(request)
  if (!role || !roles.has(role[1]!)) throw failure('INVALID_INPUT')
  if (!role[2]) return page.getByRole(role[1] as Parameters<Page['getByRole']>[0])
  try {
    const name = JSON.parse(role[2]) as unknown
    if (typeof name !== 'string' || name.length === 0) throw failure('INVALID_INPUT')
    return page.getByRole(role[1] as Parameters<Page['getByRole']>[0], { name, exact: true })
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) throw error
    throw failure('INVALID_INPUT')
  }
}

async function uniqueLocator(page: Page, request: string): Promise<Locator> {
  const locator = locatorFor(page, request)
  if (await locator.count() !== 1) throw failure('INVALID_INPUT')
  return locator
}

interface NavigationResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
}

async function fetchNavigationWithoutRedirect(
  url: string,
  method: string,
  headers: Record<string, string>,
  postData: Buffer | null,
): Promise<NavigationResponse> {
  const body = postData
    ? postData.buffer.slice(postData.byteOffset, postData.byteOffset + postData.byteLength) as ArrayBuffer
    : undefined
  const response = await fetch(url, {
    method,
    headers,
    redirect: 'manual',
    ...(!['GET', 'HEAD'].includes(method) && body
      ? { body }
      : {}),
  })
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: Buffer.from(await response.arrayBuffer()),
  }
}

export class BrowserCapabilityService implements CapabilityPort {
  private readonly authorization: BrowserAuthorizationPort
  private readonly headless: boolean
  private readonly launcher: BrowserLauncher
  private readonly profiles: BrowserProfileDirectories
  private readonly runtime: Omit<BrowserRuntimeOptions, 'developmentExecutablePath'>
  private readonly executions = new Map<string, ExecutionBrowserState>()
  private readonly pageOwners = new WeakMap<Page, string>()

  constructor(options: BrowserCapabilityServiceOptions) {
    this.authorization = options.authorization
    this.headless = options.headless ?? false
    this.launcher = options.launcher ?? {
      executablePath: () => chromium.executablePath(),
      launchPersistentContext: (directory, launchOptions) => chromium.launchPersistentContext(directory, launchOptions),
    }
    this.profiles = options.profileDirectories ?? {
      create: () => mkdtemp(join(tmpdir(), 'autoforge-browser-')),
      remove: (path) => rm(path, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      }),
    }
    this.runtime = options.runtime ?? { packaged: false }
  }

  activeContexts(executionId: string): number {
    return this.executions.get(executionId)?.owner?.contextOpen ? 1 : 0
  }

  async request(context: BrowserCapabilityContext, request: WorkerCapabilityRequest): Promise<unknown> {
    switch (request.capability) {
      case 'browser.open':
        return this.open(context, request.arguments.url, request.scope)
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

  async open(context: BrowserCapabilityContext, url: string, declaredScope?: CapabilityScope): Promise<void> {
    return this.executeCapability(context, 'browser.open', declaredScope, true, true, async (state) => {
      const requestedOrigin = originOf(url)
      await this.authorizeOperation({ context, capability: 'browser.open', declaredScope }, requestedOrigin)
      this.assertAvailable(state)
      const owner = await this.ensureOwner(state)
      this.assertAvailable(state)
      await owner.primaryPage.goto(url)
      await this.authorizeOperation(
        { context, capability: 'browser.open', declaredScope },
        originOf(owner.primaryPage.url()),
      )
    })
  }

  async fill(
    context: BrowserCapabilityContext,
    locator: string,
    value: string,
    declaredScope?: CapabilityScope,
  ): Promise<void> {
    return this.executeCapability(context, 'browser.fill', declaredScope, false, false, async (state) => {
      const owner = this.owner(state)
      await this.authorizeOperation(
        { context, capability: 'browser.fill', declaredScope },
        originOf(owner.primaryPage.url()),
      )
      await (await uniqueLocator(owner.primaryPage, locator)).fill(value)
      await this.authorizeOperation(
        { context, capability: 'browser.fill', declaredScope },
        originOf(owner.primaryPage.url()),
      )
    })
  }

  async click(
    context: BrowserCapabilityContext,
    locator: string,
    declaredScope?: CapabilityScope,
  ): Promise<void> {
    return this.executeCapability(context, 'browser.click', declaredScope, false, false, async (state) => {
      const owner = this.owner(state)
      await this.authorizeOperation(
        { context, capability: 'browser.click', declaredScope },
        originOf(owner.primaryPage.url()),
      )
      await (await uniqueLocator(owner.primaryPage, locator)).click()
      await this.authorizeOperation(
        { context, capability: 'browser.click', declaredScope },
        originOf(owner.primaryPage.url()),
      )
    })
  }

  async url(context: BrowserCapabilityContext, declaredScope?: CapabilityScope): Promise<string> {
    return this.executeCapability(context, 'browser.url', declaredScope, false, false, async (state) => {
      const url = this.owner(state).primaryPage.url()
      await this.authorizeOperation(
        { context, capability: 'browser.url', declaredScope },
        originOf(url),
      )
      return url
    })
  }

  async close(context: BrowserCapabilityContext, declaredScope?: CapabilityScope): Promise<void> {
    await this.executeCapability(context, 'browser.close', declaredScope, false, false, async (state) => {
      await this.authorizeOperation(
        { context, capability: 'browser.close', declaredScope },
        originOf(this.owner(state).primaryPage.url()),
      )
    })
    await this.closeExecution(context.executionId)
  }

  async closeExecution(executionId: string): Promise<void> {
    const state = this.executions.get(executionId)
    if (!state) return
    state.closing = true
    if (state.closePromise) return state.closePromise
    const closePromise = this.cleanupExecution(state)
    state.closePromise = closePromise
    try {
      await closePromise
    } catch (error) {
      if (state.closePromise === closePromise) state.closePromise = undefined
      throw error
    }
  }

  private owner(state: ExecutionBrowserState): OwnedBrowser {
    const owner = state.owner
    if (!owner?.contextOpen || owner.primaryPage.isClosed()) throw failure('NOT_FOUND')
    return owner
  }

  private authorize(
    context: BrowserCapabilityContext,
    capability: BrowserCapability,
    origin: string,
  ): Promise<void> {
    return Promise.resolve(this.authorization.authorize(context, { capability, scope: browserScope(origin) }))
  }

  private ensureOwner(state: ExecutionBrowserState): Promise<OwnedBrowser> {
    const owner = state.owner
    if (owner) return Promise.resolve(owner)
    const pending = state.creation
    if (pending) return pending
    const creation = this.createOwner(state)
    state.creation = creation
    void creation.finally(() => {
      if (state.creation === creation) state.creation = undefined
    }).catch(() => undefined)
    return creation
  }

  private async createOwner(state: ExecutionBrowserState): Promise<OwnedBrowser> {
    const executablePath = await resolveBrowserExecutablePath(this.runtime.packaged
      ? this.runtime
      : { ...this.runtime, developmentExecutablePath: this.launcher.executablePath() })
    const profilePath = await this.profiles.create()
    state.profilePath = profilePath
    let context: BrowserContext
    try {
      context = await this.launcher.launchPersistentContext(profilePath, {
        headless: this.headless,
        executablePath,
        serviceWorkers: 'block',
      })
    } catch (error) {
      try {
        await this.removeProfile(profilePath)
        state.profilePath = undefined
      } catch {
        // Keep the profile path in execution state so closeExecution can retry cleanup.
      }
      throw error
    }

    const primaryPage = context.pages()[0] ?? await context.newPage()
    const owner: OwnedBrowser = {
      context,
      primaryPage,
      pages: new Set(),
      profilePath,
      contextOpen: true,
      pendingGuards: new Set(),
      routedFrames: new WeakSet(),
      redirectedUrls: new Map(),
    }
    state.owner = owner
    const associate = (page: Page) => this.associatePage(state, owner, page)
    for (const page of context.pages()) associate(page)
    context.on('page', associate)
    context.once('close', () => { owner.contextOpen = false })
    await context.route('**/*', (route, request) => this.trackGuard(
      owner,
      this.guardMainFrameRequest(state, owner, route, request),
    ))
    return owner
  }

  private beginOperation(executionId: string, create: boolean): ExecutionBrowserState {
    let state = this.executions.get(executionId)
    if (!state) {
      if (!create) throw failure('NOT_FOUND')
      state = {
        executionId,
        closing: false,
        activeOperations: 0,
        idleWaiters: new Set(),
      }
      this.executions.set(executionId, state)
    }
    this.assertAvailable(state)
    if (state.operation) throw failure('CONFLICT')
    state.activeOperations += 1
    return state
  }

  private endOperation(state: ExecutionBrowserState): void {
    state.activeOperations -= 1
    if (state.activeOperations === 0) {
      for (const resolveIdle of state.idleWaiters) resolveIdle()
      state.idleWaiters.clear()
      if (!state.closing && !state.owner && !state.profilePath && !state.creation) {
        this.executions.delete(state.executionId)
      }
    }
  }

  private async executeCapability<T>(
    context: BrowserCapabilityContext,
    capability: BrowserCapability,
    declaredScope: CapabilityScope | undefined,
    create: boolean,
    closeOnFailure: boolean,
    action: (state: ExecutionBrowserState) => Promise<T>,
  ): Promise<T> {
    const state = this.beginOperation(context.executionId, create)
    const operation: ActiveBrowserOperation = { context, capability, ...(declaredScope ? { declaredScope } : {}) }
    state.operation = operation
    state.violation = undefined
    let result!: T
    let problem: unknown
    let failed = false
    try {
      result = await action(state)
      await this.drainGuards(state.owner)
      await this.applyRedirectedUrls(state.owner)
      await this.drainGuards(state.owner)
      if (state.violation) throw state.violation
      this.assertAvailable(state)
    } catch (error) {
      failed = true
      problem = state.violation ?? error
    } finally {
      if (state.operation === operation) state.operation = undefined
      this.endOperation(state)
    }

    if (failed && (closeOnFailure || state.closing || state.violation)) {
      try {
        await this.closeExecution(state.executionId)
      } catch {
        // Preserve the capability failure; retained cleanup state remains retryable.
      }
    }
    if (failed) throw problem
    return result
  }

  private assertAvailable(state: ExecutionBrowserState): void {
    if (state.closing) throw failure('CANCELLED')
  }

  private authorizeOperation(operation: ActiveBrowserOperation, origin: string): Promise<void> {
    if (operation.declaredScope) assertExactScope(operation.declaredScope, origin)
    return this.authorize(operation.context, operation.capability, origin)
  }

  private associatePage(state: ExecutionBrowserState, owner: OwnedBrowser, page: Page): void {
    owner.pages.add(page)
    this.pageOwners.set(page, state.executionId)
    page.once('close', () => owner.pages.delete(page))
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame() || frame.url() === 'about:blank') return
      if (owner.routedFrames.delete(frame)) return
      const operation = state.operation
      void this.trackGuard(
        owner,
        this.guardFrameNavigation(state, operation, frame.url()),
      ).catch(() => undefined)
    })
  }

  private async guardMainFrameRequest(
    state: ExecutionBrowserState,
    owner: OwnedBrowser,
    route: Route,
    request: Request,
  ): Promise<void> {
    if (!request.isNavigationRequest()) {
      await route.continue()
      return
    }
    let frame: Frame | undefined
    try {
      frame = request.frame()
      if (frame !== frame.page().mainFrame()) {
        await route.continue()
        return
      }
    } catch {
      // Initial popup navigation has no Frame yet, but is necessarily its new page's main frame.
    }
    const operation = state.operation
    if (!operation) {
      await route.abort('blockedbyclient').catch(() => undefined)
      this.recordNavigationViolation(state, failure('CAPABILITY_SCOPE_DENIED'))
      return
    }
    try {
      await this.authorizeOperation(operation, originOf(request.url()))
    } catch (error) {
      await route.abort('blockedbyclient').catch(() => undefined)
      this.recordNavigationViolation(state, error)
      return
    }
    let navigationResponse: NavigationResponse
    let finalUrl: string
    try {
      ({ response: navigationResponse, finalUrl } = await this.fetchNavigationChain(operation, request))
    } catch (error) {
      if (toSafeAppError(error).code !== 'CAPABILITY_SCOPE_DENIED') throw error
      await route.abort('blockedbyclient').catch(() => undefined)
      this.recordNavigationViolation(state, error)
      return
    }
    if (finalUrl !== request.url()) owner.redirectedUrls.set(request.url(), finalUrl)
    if (frame) owner.routedFrames.add(frame)
    await route.fulfill(navigationResponse)
  }

  private async guardFrameNavigation(
    state: ExecutionBrowserState,
    operation: ActiveBrowserOperation | undefined,
    url: string,
  ): Promise<void> {
    if (!operation) {
      this.recordNavigationViolation(state, failure('CAPABILITY_SCOPE_DENIED'))
      return
    }
    try {
      await this.authorizeOperation(operation, originOf(url))
    } catch (error) {
      this.recordNavigationViolation(state, error)
    }
  }

  private recordNavigationViolation(state: ExecutionBrowserState, error: unknown): void {
    state.violation ??= toSafeAppError(error)
    state.closing = true
    void this.closeExecution(state.executionId).catch(() => undefined)
  }

  private trackGuard(owner: OwnedBrowser, guard: Promise<void>): Promise<void> {
    owner.pendingGuards.add(guard)
    void guard.finally(() => owner.pendingGuards.delete(guard)).catch(() => undefined)
    return guard
  }

  private async drainGuards(owner: OwnedBrowser | undefined): Promise<void> {
    if (!owner) return
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
    while (owner.pendingGuards.size > 0) {
      await Promise.allSettled([...owner.pendingGuards])
    }
  }

  private async fetchNavigationChain(
    operation: ActiveBrowserOperation,
    request: Request,
  ): Promise<{ response: NavigationResponse; finalUrl: string }> {
    let url = request.url()
    let method = request.method()
    let postData = request.postDataBuffer()
    const headers = await request.allHeaders()
    for (const name of ['connection', 'content-length', 'host']) delete headers[name]

    for (let redirectCount = 0; redirectCount <= 10; redirectCount += 1) {
      const response = await fetchNavigationWithoutRedirect(url, method, headers, postData)
      const location = response.headers.location
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
        return { response, finalUrl: url }
      }
      if (redirectCount === 10) throw failure('INVALID_INPUT')
      url = new URL(location, url).href
      await this.authorizeOperation(operation, originOf(url))
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET'
        postData = null
        delete headers['content-type']
      }
    }
    throw failure('INVALID_INPUT')
  }

  private async applyRedirectedUrls(owner: OwnedBrowser | undefined): Promise<void> {
    if (!owner || owner.redirectedUrls.size === 0) return
    for (const page of owner.pages) {
      const finalUrl = owner.redirectedUrls.get(page.url())
      if (!finalUrl) continue
      owner.redirectedUrls.delete(page.url())
      await page.evaluate((url) => history.replaceState(null, '', url), finalUrl)
    }
  }

  private waitForIdle(state: ExecutionBrowserState): Promise<void> {
    if (state.activeOperations === 0) return Promise.resolve()
    return new Promise((resolveIdle) => state.idleWaiters.add(resolveIdle))
  }

  private async cleanupExecution(state: ExecutionBrowserState): Promise<void> {
    await this.waitForIdle(state)
    const owner = state.owner
    if (owner?.contextOpen) {
      await owner.context.close()
      owner.contextOpen = false
    }
    if (state.profilePath) {
      await this.removeProfile(state.profilePath)
      state.profilePath = undefined
    }
    owner?.pages.clear()
    state.owner = undefined
    if (this.executions.get(state.executionId) === state) this.executions.delete(state.executionId)
  }

  private async removeProfile(path: string): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.profiles.remove(path)
        return
      } catch (error) {
        lastError = error
        if (attempt < 2) {
          await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50 * (attempt + 1)))
        }
      }
    }
    throw lastError
  }
}
