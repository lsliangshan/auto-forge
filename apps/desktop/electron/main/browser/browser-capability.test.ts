import { createServer, type Server } from 'node:http'
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  let testRoot: string
  let profiles: CapturedProfileDirectories
  let authorization: LoopbackAuthorization
  let browser: BrowserCapabilityService

  beforeEach(async () => {
    fixtureServer = createServer((request, response) => {
      if (request.url === '/redirect-outside') {
        response.writeHead(302, { location: `http://localhost:${new URL(fixtureOrigin).port}/` })
        response.end()
        return
      }
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end(`<!doctype html>
        <label>Keyword <input id="keyword" /></label>
        <button id="submit" onclick="history.pushState({}, '', '/result?q=' + encodeURIComponent(document.querySelector('#keyword').value))">Submit</button>
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
    await browser.closeExecution(approvedContext.executionId)
    await closeServer(fixtureServer)
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
    expect(authorization.calls.map(({ capability }) => capability)).toEqual([
      'browser.open',
      'browser.open',
      'browser.fill',
      'browser.fill',
      'browser.click',
      'browser.click',
      'browser.url',
      'browser.click',
      'browser.click',
    ])
  })

  it('rejects a redirect whose final page has an ungranted origin and removes its profile', async () => {
    await expect(browser.open(approvedContext, `${fixtureOrigin}/redirect-outside`))
      .rejects.toMatchObject(denied())

    expect(browser.activeContexts(approvedContext.executionId)).toBe(0)
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
    }
    const context = {
      pages: () => [page],
      newPage: async () => page,
      on: () => undefined,
      once: () => undefined,
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
    await expect(readFile(join(resourcesDirectory, 'browser-runtime.json'), 'utf8'))
      .resolves.toBe(`${JSON.stringify(result, null, 2)}\n`)
    await rm(root, { recursive: true, force: true })
  })
})
