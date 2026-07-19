import { createServer, type Server, type ServerResponse } from 'node:http'
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chromium, type BrowserContext, type Page } from 'playwright-chromium'
import type { Capability, CapabilityScope } from '@autoforge/shared'
import {
  BrowserCapabilityService,
  PolicyEngineBrowserAuthorization,
  resolveBrowserExecutablePath,
  type BrowserAuthorizationPort,
  type BrowserCapabilityContext,
  type BrowserProfileDirectories,
} from './browser-capability.js'
// @ts-expect-error The staging entry point is a plain Node ESM script.
import { findBrowserArchiveRoot, stageBrowser } from '../../../scripts/stage-browser.mjs'

const approvedContext: BrowserCapabilityContext = {
  executionId: 'exec_approved',
  workflowId: 'com.autoforge.fixture',
  workflowVersion: '1.0.0',
}

function denied(): { code: 'CAPABILITY_SCOPE_DENIED' } {
  return { code: 'CAPABILITY_SCOPE_DENIED' }
}

class LoopbackAuthorization implements BrowserAuthorizationPort {
  readonly calls: Array<{ capability: Capability; scope: CapabilityScope }> = []

  constructor(private readonly allowedOrigin: string) {}

  authorize(
    _context: BrowserCapabilityContext,
    request: { capability: Capability; scope: CapabilityScope },
  ): void {
    this.calls.push(request)
    if (!('origins' in request.scope)
      || request.scope.origins.length !== 1
      || request.scope.origins[0] !== this.allowedOrigin) {
      throw denied()
    }
  }
}

class CapturedProfileDirectories implements BrowserProfileDirectories {
  readonly created: string[] = []

  constructor(private readonly root: string) {}

  async create(): Promise<string> {
    const path = await mkdtemp(join(this.root, 'profile-'))
    this.created.push(path)
    return path
  }

  remove(path: string): Promise<void> {
    return rm(path, { recursive: true, force: true })
  }
}

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

function fakeCDPSession() {
  return {
    send: async (method: string) => method === 'Page.getFrameTree'
      ? { frameTree: { frame: { id: 'main-frame' } } }
      : {},
    on: () => undefined,
    detach: async () => undefined,
  }
}

function fakeLauncher(options: { close?: () => Promise<void> } = {}) {
  let currentUrl = 'about:blank'
  let contextCloseListener: (() => void) | undefined
  const page = {
    goto: async (url: string) => { currentUrl = url },
    url: () => currentUrl,
    isClosed: () => false,
    once: () => undefined,
    on: () => undefined,
    mainFrame: () => ({ url: () => currentUrl }),
  }
  const context = {
    pages: () => [page],
    newPage: async () => page,
    on: () => undefined,
    once: (event: string, listener: () => void) => {
      if (event === 'close') contextCloseListener = listener
    },
    route: async () => undefined,
    newCDPSession: async () => fakeCDPSession(),
    close: async () => {
      await options.close?.()
      contextCloseListener?.()
    },
  }
  return {
    executablePath: () => process.execPath,
    launchPersistentContext: async () => context as never,
  }
}

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('Missing fixture address'))
      resolve(address.port)
    })
  })
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

describe('BrowserCapabilityService', () => {
  let fixtureServer: Server
  let fixtureOrigin: string
  let outsideServer: Server
  let outsideOrigin: string
  let outsideRequests: number
  let nestedAssetRequests: string[]
  let nestedCookie: string | undefined
  let stallResponse: ServerResponse | undefined
  let stallStarted: ReturnType<typeof deferred>
  let testRoot: string
  let profiles: CapturedProfileDirectories
  let authorization: LoopbackAuthorization
  let browser: BrowserCapabilityService

  beforeEach(async () => {
    outsideRequests = 0
    nestedAssetRequests = []
    nestedCookie = undefined
    stallResponse = undefined
    stallStarted = deferred()
    outsideServer = createServer((_request, response) => {
      outsideRequests += 1
      response.end('outside')
    })
    outsideOrigin = `http://127.0.0.1:${await listen(outsideServer)}`
    fixtureServer = createServer((request, response) => {
      if (request.url === '/redirect-outside') {
        response.writeHead(302, { location: `${outsideOrigin}/redirect-target` })
        response.end()
        return
      }
      if (request.url === '/redirect-same-origin') {
        response.writeHead(302, { location: `${fixtureOrigin}/redirect-outside` })
        response.end()
        return
      }
      if (request.url === '/redirect-final') {
        response.writeHead(302, { location: `${fixtureOrigin}/final-page` })
        response.end()
        return
      }
      if (request.url === '/popup-redirect-outside') {
        response.writeHead(302, { location: `${outsideOrigin}/popup-redirect-target` })
        response.end()
        return
      }
      if (request.url === '/start') {
        response.writeHead(302, {
          location: `${fixtureOrigin}/nested/page`,
          'set-cookie': 'redirect-session=present; Path=/',
        })
        response.end()
        return
      }
      if (request.url === '/nested/page') {
        nestedCookie = request.headers.cookie
        response.setHeader('content-type', 'text/html; charset=utf-8')
        response.end('<!doctype html><script src="./asset.js"></script><p>Nested</p>')
        return
      }
      if (request.url === '/nested/asset.js' || request.url === '/asset.js') {
        nestedAssetRequests.push(request.url)
        response.setHeader('content-type', 'application/javascript')
        response.end('globalThis.__nestedAssetLoaded = true')
        return
      }
      if (request.url === '/stall') {
        stallResponse = response
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.write('<!doctype html><p>still loading')
        stallStarted.resolve(undefined)
        return
      }
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end(`<!doctype html>
        <label>Keyword <input id="keyword" /></label>
        <button id="submit" onclick="history.pushState({}, '', '/result?q=' + encodeURIComponent(document.querySelector('#keyword').value))">Submit</button>
        <button id="popup" onclick="window.open('${outsideOrigin}/popup')">Popup</button>
        <button id="popup-inside" onclick="window.open('${fixtureOrigin}/popup-redirect-outside')">Popup inside</button>
        <button id="delayed" onclick="setTimeout(() => { location.href = '${outsideOrigin}/delayed' }, 30)">Delayed</button>
        <button id="delayed-history" onclick="setTimeout(() => { history.pushState({}, '', '/late-history') }, 30)">Delayed history</button>
        <button class="duplicate">One</button><button class="duplicate">Two</button>`)
    })
    const port = await listen(fixtureServer)
    fixtureOrigin = `http://127.0.0.1:${port}`
    testRoot = await mkdtemp(join(tmpdir(), 'autoforge-browser-test-'))
    profiles = new CapturedProfileDirectories(testRoot)
    authorization = new LoopbackAuthorization(fixtureOrigin)
    browser = new BrowserCapabilityService({
      authorization,
      headless: process.env.CI === '1',
      profileDirectories: profiles,
    })
  })

  afterEach(async () => {
    stallResponse?.destroy()
    await browser.closeExecution(approvedContext.executionId)
    await closeServer(fixtureServer)
    await closeServer(outsideServer)
    await rm(testRoot, { recursive: true, force: true })
  })

  it('rejects navigation outside the granted exact origin before launching Chromium', async () => {
    await expect(browser.open(approvedContext, 'https://example.com')).rejects.toMatchObject(denied())
    expect(browser.activeContexts(approvedContext.executionId)).toBe(0)
    expect(profiles.created).toEqual([])
  })

  it('uses only CSS and role/name locators and requires one exact match', async () => {
    await browser.open(approvedContext, fixtureOrigin)
    await browser.fill(approvedContext, 'css=#keyword', 'AutoForge')
    await browser.click(approvedContext, 'role=button[name="Submit"]')

    expect(await browser.url(approvedContext)).toBe(`${fixtureOrigin}/result?q=AutoForge`)
    await expect(browser.click(approvedContext, 'css=.duplicate')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(browser.click(approvedContext, 'text=Submit')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(new Set(authorization.calls.map(({ capability }) => capability))).toEqual(new Set([
      'browser.open', 'browser.fill', 'browser.click', 'browser.url',
    ]))
    expect(authorization.calls.every(({ scope }) => (
      'origins' in scope && scope.origins[0] === fixtureOrigin
    ))).toBe(true)
  })

  it('rejects a redirect whose final page has an ungranted origin and removes its profile', async () => {
    await expect(browser.open(approvedContext, `${fixtureOrigin}/redirect-outside`))
      .rejects.toMatchObject(denied())

    expect(browser.activeContexts(approvedContext.executionId)).toBe(0)
    expect(outsideRequests).toBe(0)
    await expect(stat(profiles.created[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('blocks an unauthorized popup before its main-frame request is sent and cleans the execution', async () => {
    await browser.open(approvedContext, fixtureOrigin)

    await expect(browser.click(approvedContext, 'role=button[name="Popup"]'))
      .rejects.toMatchObject(denied())

    expect(outsideRequests).toBe(0)
    expect(browser.activeContexts(approvedContext.executionId)).toBe(0)
    await expect(stat(profiles.created[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('guards every hop before an allowed same-origin redirect can reach an unauthorized origin', async () => {
    await expect(browser.open(approvedContext, `${fixtureOrigin}/redirect-same-origin`))
      .rejects.toMatchObject(denied())

    expect(outsideRequests).toBe(0)
    expect(browser.activeContexts(approvedContext.executionId)).toBe(0)
  })

  it('rejects a frame-less same-origin popup before its redirect can reach an unauthorized origin', async () => {
    await browser.open(approvedContext, fixtureOrigin)

    await expect(browser.click(approvedContext, 'role=button[name="Popup inside"]'))
      .rejects.toMatchObject(denied())

    expect(outsideRequests).toBe(0)
    expect(browser.activeContexts(approvedContext.executionId)).toBe(0)
    await expect(stat(profiles.created[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps request guards attached after context close fails until a later close succeeds', async () => {
    const allowSuccessfulClose = deferred()
    let closeAttempts = 0
    let launchedContext: BrowserContext | undefined
    const guardedBrowser = new BrowserCapabilityService({
      authorization,
      headless: process.env.CI === '1',
      profileDirectories: profiles,
      launcher: {
        executablePath: () => chromium.executablePath(),
        launchPersistentContext: async (directory, options) => {
          const context = await chromium.launchPersistentContext(directory, options)
          launchedContext = context
          const closeContext = context.close.bind(context)
          context.close = async () => {
            closeAttempts += 1
            if (closeAttempts === 1) throw new Error('context busy')
            await allowSuccessfulClose.promise
            await closeContext()
          }
          return context
        },
      },
    })

    try {
      await guardedBrowser.open(approvedContext, fixtureOrigin)
      await expect(guardedBrowser.closeExecution(approvedContext.executionId)).rejects.toThrow('context busy')

      const externalNavigation = launchedContext!.pages()[0]!.goto(`${outsideOrigin}/after-close-failure`)
      await expect(externalNavigation).rejects.toThrow()
      expect(outsideRequests).toBe(0)

      const closing = guardedBrowser.closeExecution(approvedContext.executionId)
      allowSuccessfulClose.resolve()
      await expect(closing).resolves.toBeUndefined()

      expect(closeAttempts).toBe(2)
      expect(guardedBrowser.activeContexts(approvedContext.executionId)).toBe(0)
      await expect(stat(profiles.created[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      allowSuccessfulClose.resolve()
      await guardedBrowser.closeExecution(approvedContext.executionId).catch(() => undefined)
    }
  })

  it('retains a late popup error-page guard when its first context close fails', async () => {
    const allowSuccessfulClose = deferred()
    const firstCloseFailed = deferred()
    const popupGuardAttached = deferred<Page>()
    let closeAttempts = 0
    let forceCloseContext: (() => Promise<void>) | undefined
    let launchedContext: BrowserContext | undefined
    let primaryPage: Page | undefined
    const guardedBrowser = new BrowserCapabilityService({
      authorization,
      headless: process.env.CI === '1',
      profileDirectories: profiles,
      launcher: {
        executablePath: () => chromium.executablePath(),
        launchPersistentContext: async (directory, options) => {
          const context = await chromium.launchPersistentContext(directory, options)
          launchedContext = context
          const createSession = context.newCDPSession.bind(context)
          context.newCDPSession = async (page) => {
            const session = await createSession(page)
            if (primaryPage && page !== primaryPage && 'mainFrame' in page) {
              const sessionRecord = session as unknown as {
                send(method: string, params?: unknown): Promise<unknown>
              }
              const send = sessionRecord.send.bind(sessionRecord)
              sessionRecord.send = async (method, params) => {
                const result = await send(method, params)
                if (method === 'Fetch.enable') popupGuardAttached.resolve(page)
                return result
              }
            }
            return session
          }
          const closeContext = context.close.bind(context)
          forceCloseContext = closeContext
          context.close = async () => {
            closeAttempts += 1
            if (closeAttempts === 1) {
              firstCloseFailed.resolve()
              throw new Error('context busy')
            }
            await allowSuccessfulClose.promise
            await closeContext()
          }
          return context
        },
      },
    })

    try {
      await guardedBrowser.open(approvedContext, fixtureOrigin)
      primaryPage = launchedContext!.pages()[0]
      const clicking = guardedBrowser.click(approvedContext, 'role=button[name="Popup inside"]')
      void clicking.catch(() => undefined)
      await Promise.race([
        firstCloseFailed.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('first close did not fail')), 2_000)),
      ])
      const popupPage = await Promise.race([
        popupGuardAttached.promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('popup guard did not attach')), 2_000)),
      ])

      await expect(popupPage.goto(`${outsideOrigin}/after-popup-close-failure`)).rejects.toThrow()
      expect(outsideRequests).toBe(0)

      const closing = guardedBrowser.closeExecution(approvedContext.executionId)
      allowSuccessfulClose.resolve()
      await expect(closing).resolves.toBeUndefined()
      await expect(clicking).rejects.toMatchObject(denied())

      expect(closeAttempts).toBe(2)
      expect(guardedBrowser.activeContexts(approvedContext.executionId)).toBe(0)
      await expect(stat(profiles.created[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      allowSuccessfulClose.resolve()
      await Promise.race([
        guardedBrowser.closeExecution(approvedContext.executionId).catch(() => undefined),
        new Promise<void>((resolveCleanup) => setTimeout(resolveCleanup, 2_000)),
      ])
      await forceCloseContext?.().catch(() => undefined)
    }
  }, 15_000)

  it('preserves the final URL after safely resolving an allowed same-origin redirect', async () => {
    await browser.open(approvedContext, `${fixtureOrigin}/redirect-final`)

    expect(await browser.url(approvedContext)).toBe(`${fixtureOrigin}/final-page`)
    expect(browser.activeContexts(approvedContext.executionId)).toBe(1)
  })

  it('keeps Chromium redirect cookies and resolves relative assets from the final URL', async () => {
    await browser.open(approvedContext, `${fixtureOrigin}/start`)

    expect(await browser.url(approvedContext)).toBe(`${fixtureOrigin}/nested/page`)
    expect(nestedCookie).toContain('redirect-session=present')
    expect(nestedAssetRequests).toEqual(['/nested/asset.js'])
  })

  it('closes a stalled native navigation promptly and removes its profile', async () => {
    const opening = browser.open(approvedContext, `${fixtureOrigin}/stall`)
    await stallStarted.promise
    const closing = browser.closeExecution(approvedContext.executionId)

    try {
      await expect(Promise.race([
        closing,
        new Promise((_, reject) => setTimeout(() => reject(new Error('close timed out')), 1_000)),
      ])).resolves.toBeUndefined()
    } finally {
      stallResponse?.destroy()
      await opening.catch(() => undefined)
      await closing.catch(() => undefined)
    }

    expect(browser.activeContexts(approvedContext.executionId)).toBe(0)
    await expect(stat(profiles.created[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('blocks delayed main-frame navigation outside an active operation and cleans the execution', async () => {
    await browser.open(approvedContext, fixtureOrigin)
    await browser.click(approvedContext, 'role=button[name="Delayed"]')

    await expect.poll(() => browser.activeContexts(approvedContext.executionId), { timeout: 2_000 })
      .toBe(0)
    expect(outsideRequests).toBe(0)
    await browser.closeExecution(approvedContext.executionId)
    await expect(stat(profiles.created[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('closes the execution for delayed script-only navigation outside an active operation', async () => {
    await browser.open(approvedContext, fixtureOrigin)
    await browser.click(approvedContext, 'role=button[name="Delayed history"]')

    await expect.poll(() => browser.activeContexts(approvedContext.executionId), { timeout: 2_000 })
      .toBe(0)
    await browser.closeExecution(approvedContext.executionId)
    await expect(stat(profiles.created[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('closes every context owned by an execution and deletes its persistent profile', async () => {
    const second = { ...approvedContext, executionId: 'exec_second' }
    await browser.open(approvedContext, fixtureOrigin)
    await browser.open(second, fixtureOrigin)

    expect(browser.activeContexts(approvedContext.executionId)).toBe(1)
    expect(browser.activeContexts(second.executionId)).toBe(1)
    await browser.closeExecution(approvedContext.executionId)

    expect(browser.activeContexts(approvedContext.executionId)).toBe(0)
    expect(browser.activeContexts(second.executionId)).toBe(1)
    await expect(stat(profiles.created[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
    await browser.closeExecution(second.executionId)
  })

  it('implements the Task 6 capability port and rejects a caller scope that differs from the page origin', async () => {
    await expect(browser.request(approvedContext, {
      capability: 'browser.open',
      scope: { origins: ['https://example.com'] },
      arguments: { url: 'https://www.example.com' },
    })).rejects.toMatchObject(denied())
  })
})

describe('production browser authorization', () => {
  it('rejects insecure origins before consulting persisted policy grants', () => {
    let evaluations = 0
    const authorization = new PolicyEngineBrowserAuthorization({
      evaluate: () => {
        evaluations += 1
        return { allowed: true, requiresApproval: false }
      },
    })

    expect(() => authorization.authorize(approvedContext, {
      capability: 'browser.open',
      scope: { origins: ['http://127.0.0.1:3000'] },
    })).toThrowError(expect.objectContaining(denied()))
    expect(evaluations).toBe(0)
  })

  it('returns a safe scope denial for an invalid origin', () => {
    const authorization = new PolicyEngineBrowserAuthorization({
      evaluate: () => ({ allowed: true, requiresApproval: false }),
    })

    expect(() => authorization.authorize(approvedContext, {
      capability: 'browser.open',
      scope: { origins: ['not a URL'] },
    })).toThrowError({
      code: 'CAPABILITY_SCOPE_DENIED',
      message: 'The requested capability scope is not allowed.',
    })
  })
})

describe('browser execution lifecycle', () => {
  it('registers an in-flight open before authorization so concurrent close prevents a late launch', async () => {
    const authorizationStarted = deferred()
    const releaseAuthorization = deferred()
    let launches = 0
    const launcher = {
      executablePath: () => process.execPath,
      launchPersistentContext: async () => {
        launches += 1
        throw new Error('late launch')
      },
    }
    const service = new BrowserCapabilityService({
      authorization: {
        authorize: async () => {
          authorizationStarted.resolve()
          await releaseAuthorization.promise
        },
      },
      launcher,
    })

    const opening = service.open(approvedContext, 'https://example.com')
    await authorizationStarted.promise
    const closing = service.closeExecution(approvedContext.executionId)
    releaseAuthorization.resolve()

    await expect(opening).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(closing).resolves.toBeUndefined()
    expect(launches).toBe(0)
    expect(service.activeContexts(approvedContext.executionId)).toBe(0)
  })

  it('retries a transient profile deletion before releasing cleanup ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-cleanup-test-'))
    let removalAttempts = 0
    const profiles = new CapturedProfileDirectories(root)
    const service = new BrowserCapabilityService({
      authorization: { authorize: () => undefined },
      launcher: fakeLauncher(),
      profileDirectories: {
        create: () => profiles.create(),
        remove: async (path) => {
          removalAttempts += 1
          if (removalAttempts === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
          await profiles.remove(path)
        },
      },
    })
    await service.open(approvedContext, 'https://example.com')

    await expect(service.closeExecution(approvedContext.executionId)).resolves.toBeUndefined()

    expect(removalAttempts).toBe(2)
    expect(service.activeContexts(approvedContext.executionId)).toBe(0)
    await expect(stat(profiles.created[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(root, { recursive: true, force: true })
  })

  it('keeps failed context cleanup retryable until a later close succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-cleanup-test-'))
    const profiles = new CapturedProfileDirectories(root)
    let closeAttempts = 0
    const service = new BrowserCapabilityService({
      authorization: { authorize: () => undefined },
      launcher: fakeLauncher({
        close: async () => {
          closeAttempts += 1
          if (closeAttempts === 1) throw new Error('context busy')
        },
      }),
      profileDirectories: profiles,
    })
    await service.open(approvedContext, 'https://example.com')

    await expect(service.closeExecution(approvedContext.executionId)).rejects.toThrow('context busy')
    expect(service.activeContexts(approvedContext.executionId)).toBe(1)
    await expect(service.closeExecution(approvedContext.executionId)).resolves.toBeUndefined()

    expect(closeAttempts).toBe(2)
    expect(service.activeContexts(approvedContext.executionId)).toBe(0)
    await expect(stat(profiles.created[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(root, { recursive: true, force: true })
  })
})

describe('packaged Chromium runtime resolution', () => {
  it('resolves an existing manifest-relative executable under resourcesPath', async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), 'autoforge-runtime-test-'))
    const executablePath = join(resourcesPath, 'ms-playwright', 'chromium-1', 'chrome-win', 'chrome.exe')
    await mkdir(join(resourcesPath, 'ms-playwright', 'chromium-1', 'chrome-win'), { recursive: true })
    await writeFile(executablePath, '')
    await writeFile(join(resourcesPath, 'browser-runtime.json'), JSON.stringify({
      version: 1,
      executablePath: 'ms-playwright/chromium-1/chrome-win/chrome.exe',
    }))

    await expect(resolveBrowserExecutablePath({ packaged: true, resourcesPath }))
      .resolves.toBe(await import('node:fs/promises').then(({ realpath }) => realpath(executablePath)))
    await rm(resourcesPath, { recursive: true, force: true })
  })

  it('rejects a packaged runtime manifest that escapes resourcesPath', async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), 'autoforge-runtime-test-'))
    await writeFile(join(resourcesPath, 'browser-runtime.json'), JSON.stringify({
      version: 1,
      executablePath: '../outside/chrome',
    }))

    await expect(resolveBrowserExecutablePath({ packaged: true, resourcesPath }))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(JSON.parse(await readFile(join(resourcesPath, 'browser-runtime.json'), 'utf8'))).toBeTruthy()
    await rm(resourcesPath, { recursive: true, force: true })
  })

  it('launches packaged Chromium with its staged path without consulting the development cache', async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), 'autoforge-runtime-test-'))
    const executablePath = join(resourcesPath, 'ms-playwright', 'chromium-1', 'chrome-mac', 'chrome')
    await mkdir(join(resourcesPath, 'ms-playwright', 'chromium-1', 'chrome-mac'), { recursive: true })
    await writeFile(executablePath, '')
    await writeFile(join(resourcesPath, 'browser-runtime.json'), JSON.stringify({
      version: 1,
      executablePath: 'ms-playwright/chromium-1/chrome-mac/chrome',
    }))
    let currentUrl = 'about:blank'
    let launchOptions: { headless: boolean; executablePath: string } | undefined
    const page = {
      goto: async (url: string) => { currentUrl = url },
      url: () => currentUrl,
      isClosed: () => false,
      once: () => undefined,
      on: () => undefined,
      mainFrame: () => ({ url: () => currentUrl }),
    }
    const context = {
      pages: () => [page],
      newPage: async () => page,
      on: () => undefined,
      once: () => undefined,
      route: async () => undefined,
      newCDPSession: async () => fakeCDPSession(),
      close: async () => undefined,
    }
    const service = new BrowserCapabilityService({
      authorization: { authorize: () => undefined },
      runtime: { packaged: true, resourcesPath },
      launcher: {
        executablePath: () => { throw new Error('development cache consulted') },
        launchPersistentContext: async (_directory, options) => {
          launchOptions = options
          return context as never
        },
      },
    })

    await service.open(approvedContext, 'https://example.com')

    expect(launchOptions).toEqual({
      headless: false,
      executablePath: await import('node:fs/promises').then(({ realpath }) => realpath(executablePath)),
      serviceWorkers: 'block',
    })
    await service.closeExecution(approvedContext.executionId)
    await rm(resourcesPath, { recursive: true, force: true })
  })
})

describe('browser runtime staging', () => {
  it('finds Playwright Chromium archives on macOS and Windows paths', () => {
    expect(findBrowserArchiveRoot(
      '/cache/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    )).toBe('/cache/ms-playwright/chromium-1228')
    expect(findBrowserArchiveRoot('C:\\cache\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe'))
      .toBe('C:\\cache\\ms-playwright\\chromium-1228')
  })

  it('copies the browser archive and writes a portable relative runtime manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-stage-test-'))
    const archive = join(root, 'cache', 'chromium-1228')
    const executablePath = join(archive, 'chrome-linux', 'chrome')
    const resourcesDirectory = join(root, 'resources')
    await mkdir(join(archive, 'chrome-linux'), { recursive: true })
    await writeFile(executablePath, 'browser')
    await symlink('chrome', join(archive, 'chrome-linux', 'chrome-link'))

    const result = await stageBrowser({ executablePath, resourcesDirectory })

    expect(result.executablePath).toBe('ms-playwright/chromium-1228/chrome-linux/chrome')
    await expect(readFile(join(resourcesDirectory, result.executablePath), 'utf8')).resolves.toBe('browser')
    expect((await lstat(join(resourcesDirectory, 'ms-playwright', 'chromium-1228', 'chrome-linux', 'chrome-link')))
      .isSymbolicLink()).toBe(true)
    await expect(readlink(join(
      resourcesDirectory,
      'ms-playwright',
      'chromium-1228',
      'chrome-linux',
      'chrome-link',
    ))).resolves.toBe('chrome')
    await expect(readFile(join(resourcesDirectory, 'browser-runtime.json'), 'utf8'))
      .resolves.toBe(`${JSON.stringify(result, null, 2)}\n`)
    await rm(root, { recursive: true, force: true })
  })

  it('rejects a staged symlink whose target escapes the Chromium archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-stage-test-'))
    const archive = join(root, 'cache', 'chromium-1228')
    const executablePath = join(archive, 'chrome-linux', 'chrome')
    await mkdir(join(archive, 'chrome-linux'), { recursive: true })
    await writeFile(executablePath, 'browser')
    await writeFile(join(root, 'cache', 'outside'), 'outside')
    await symlink('../../outside', join(archive, 'chrome-linux', 'escape'))

    await expect(stageBrowser({
      executablePath,
      resourcesDirectory: join(root, 'resources'),
    })).rejects.toThrow('outside the staged Chromium archive')

    await rm(root, { recursive: true, force: true })
  })
})
