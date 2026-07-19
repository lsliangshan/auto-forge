import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright-chromium'
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
    options: { headless: boolean; executablePath: string },
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

export class BrowserCapabilityService implements CapabilityPort {
  private readonly authorization: BrowserAuthorizationPort
  private readonly headless: boolean
  private readonly launcher: BrowserLauncher
  private readonly profiles: BrowserProfileDirectories
  private readonly runtime: Omit<BrowserRuntimeOptions, 'developmentExecutablePath'>
  private readonly owners = new Map<string, OwnedBrowser>()
  private readonly creating = new Map<string, Promise<OwnedBrowser>>()
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
      remove: (path) => rm(path, { recursive: true, force: true }),
    }
    this.runtime = options.runtime ?? { packaged: false }
  }

  activeContexts(executionId: string): number {
    return this.owners.has(executionId) ? 1 : 0
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
    const requestedOrigin = originOf(url)
    if (declaredScope) assertExactScope(declaredScope, requestedOrigin)
    await this.authorize(context, 'browser.open', requestedOrigin)
    let owner: OwnedBrowser | undefined
    try {
      owner = await this.ensureOwner(context.executionId)
      await owner.primaryPage.goto(url)
      const finalOrigin = originOf(owner.primaryPage.url())
      if (declaredScope) assertExactScope(declaredScope, finalOrigin)
      await this.authorize(context, 'browser.open', finalOrigin)
    } catch (error) {
      if (owner) await this.closeExecution(context.executionId)
      throw error
    }
  }

  async fill(
    context: BrowserCapabilityContext,
    locator: string,
    value: string,
    declaredScope?: CapabilityScope,
  ): Promise<void> {
    const owner = this.owner(context.executionId)
    const origin = originOf(owner.primaryPage.url())
    if (declaredScope) assertExactScope(declaredScope, origin)
    await this.authorize(context, 'browser.fill', origin)
    await (await uniqueLocator(owner.primaryPage, locator)).fill(value)
    const finalOrigin = originOf(owner.primaryPage.url())
    if (declaredScope) assertExactScope(declaredScope, finalOrigin)
    await this.authorize(context, 'browser.fill', finalOrigin)
  }

  async click(
    context: BrowserCapabilityContext,
    locator: string,
    declaredScope?: CapabilityScope,
  ): Promise<void> {
    const owner = this.owner(context.executionId)
    const origin = originOf(owner.primaryPage.url())
    if (declaredScope) assertExactScope(declaredScope, origin)
    await this.authorize(context, 'browser.click', origin)
    await (await uniqueLocator(owner.primaryPage, locator)).click()
    const finalOrigin = originOf(owner.primaryPage.url())
    if (declaredScope) assertExactScope(declaredScope, finalOrigin)
    await this.authorize(context, 'browser.click', finalOrigin)
  }

  async url(context: BrowserCapabilityContext, declaredScope?: CapabilityScope): Promise<string> {
    const owner = this.owner(context.executionId)
    const url = owner.primaryPage.url()
    const origin = originOf(url)
    if (declaredScope) assertExactScope(declaredScope, origin)
    await this.authorize(context, 'browser.url', origin)
    return url
  }

  async close(context: BrowserCapabilityContext, declaredScope?: CapabilityScope): Promise<void> {
    const owner = this.owner(context.executionId)
    const origin = originOf(owner.primaryPage.url())
    if (declaredScope) assertExactScope(declaredScope, origin)
    await this.authorize(context, 'browser.close', origin)
    await this.closeExecution(context.executionId)
  }

  async closeExecution(executionId: string): Promise<void> {
    const pending = this.creating.get(executionId)
    if (pending) {
      try {
        await pending
      } catch {
        return
      }
    }
    const owner = this.owners.get(executionId)
    if (!owner) return
    this.owners.delete(executionId)
    try {
      await owner.context.close()
    } finally {
      await this.profiles.remove(owner.profilePath)
    }
  }

  private owner(executionId: string): OwnedBrowser {
    const owner = this.owners.get(executionId)
    if (!owner || owner.primaryPage.isClosed()) throw failure('NOT_FOUND')
    return owner
  }

  private authorize(
    context: BrowserCapabilityContext,
    capability: BrowserCapability,
    origin: string,
  ): Promise<void> {
    return Promise.resolve(this.authorization.authorize(context, { capability, scope: browserScope(origin) }))
  }

  private ensureOwner(executionId: string): Promise<OwnedBrowser> {
    const owner = this.owners.get(executionId)
    if (owner) return Promise.resolve(owner)
    const pending = this.creating.get(executionId)
    if (pending) return pending
    const creation = this.createOwner(executionId)
    this.creating.set(executionId, creation)
    void creation.finally(() => this.creating.delete(executionId)).catch(() => undefined)
    return creation
  }

  private async createOwner(executionId: string): Promise<OwnedBrowser> {
    const executablePath = await resolveBrowserExecutablePath(this.runtime.packaged
      ? this.runtime
      : { ...this.runtime, developmentExecutablePath: this.launcher.executablePath() })
    const profilePath = await this.profiles.create()
    let context: BrowserContext | undefined
    try {
      context = await this.launcher.launchPersistentContext(profilePath, {
        headless: this.headless,
        executablePath,
      })
      const primaryPage = context.pages()[0] ?? await context.newPage()
      const owner: OwnedBrowser = { context, primaryPage, pages: new Set(), profilePath }
      const associate = (page: Page) => {
        owner.pages.add(page)
        this.pageOwners.set(page, executionId)
        page.once('close', () => owner.pages.delete(page))
      }
      for (const page of context.pages()) associate(page)
      context.on('page', associate)
      context.once('close', () => {
        if (this.owners.get(executionId) !== owner) return
        this.owners.delete(executionId)
        void this.profiles.remove(profilePath).catch(() => undefined)
      })
      this.owners.set(executionId, owner)
      return owner
    } catch (error) {
      if (context) await context.close().catch(() => undefined)
      await this.profiles.remove(profilePath).catch(() => undefined)
      throw error
    }
  }
}
