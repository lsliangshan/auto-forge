import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import { startBrowserContinuationFixture, type BrowserContinuationFixture } from './browser-continuation-fixture.js'

const desktopRoot = resolve(import.meta.dirname, '../..')
const repositoryRoot = resolve(desktopRoot, '../..')
const requireFromDesktop = createRequire(join(desktopRoot, 'package.json'))
const electronExecutable = requireFromDesktop('electron') as string
const e2eMain = join(desktopRoot, '.e2e/main/browser-continuation-main.js')

interface HarnessSnapshot {
  openTabs: number
  activeBindings: number
  providerRequests: Array<{ conversationId: string; serialized: string }>
  forbiddenOperations: string[]
}

async function command<T>(
  app: ElectronApplication,
  name: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  return app.evaluate(async ({ app: electronProcess }, payload) => {
    void electronProcess
    const harness = (globalThis as typeof globalThis & {
      __AUTOFORGE_BROWSER_CONTINUATION_E2E__?: {
        dispatch(name: string, input: Record<string, unknown>): Promise<unknown>
      }
    }).__AUTOFORGE_BROWSER_CONTINUATION_E2E__
    if (!harness) throw new Error('Browser continuation E2E harness is unavailable')
    return harness.dispatch(payload.name, payload.input)
  }, { name, input }) as Promise<T>
}

async function createConversation(page: Page, app: ElectronApplication): Promise<string> {
  await page.getByRole('button', { name: '新建会话' }).first().click()
  return command<string>(app, 'selectedConversation')
}

async function sendChat(page: Page, app: ElectronApplication, conversationId: string, text: string): Promise<void> {
  await page.getByRole('textbox', { name: '消息内容' }).fill(text)
  await page.getByTestId('send-message').click()
  await command(app, 'waitForIdle', { conversationId })
}

async function seed(
  app: ElectronApplication,
  conversationId: string,
  path = '/login',
  workflowVersion = '1.0.0',
  authenticate = true,
): Promise<{ bindingId: string; tabId: string }> {
  return command(app, 'seedBinding', { conversationId, path, workflowVersion, authenticate })
}

test.describe.serial('conversation-bound browser continuation', () => {
  let fixture: BrowserContinuationFixture
  let electronApp: ElectronApplication
  let page: Page
  let userData: string

  test.beforeAll(async () => {
    fixture = await startBrowserContinuationFixture()
    userData = await mkdtemp(join(tmpdir(), 'autoforge-browser-continuation-e2e-'))
    electronApp = await _electron.launch({
      executablePath: electronExecutable,
      args: [e2eMain],
      env: {
        ...process.env,
        AUTOFORGE_E2E_DESKTOP_ROOT: desktopRoot,
        AUTOFORGE_E2E_REPOSITORY_ROOT: repositoryRoot,
        AUTOFORGE_E2E_USER_DATA: userData,
        AUTOFORGE_E2E_FIXTURE_ORIGIN: fixture.origin,
        AUTOFORGE_E2E_DISALLOWED_ORIGIN: fixture.disallowedOrigin,
        AUTOFORGE_E2E_FIXTURE_PROXY: fixture.proxyUrl,
      },
    })
    page = await electronApp.firstWindow()
    await expect(page.getByLabel('主导航')).toBeVisible()
  })

  test.beforeEach(async () => {
    await command(electronApp, 'resetScenario')
    await fixture.reset()
    await page.goto('file://' + join(desktopRoot, 'out/renderer/index.html') + '#/chat')
    await expect(page.getByLabel('主导航')).toBeVisible()
  })

  test.afterAll(async () => {
    await electronApp?.close()
    await fixture?.close()
    if (userData) await rm(userData, { recursive: true, force: true })
  })

  test('reads the authenticated expiry in the same conversation and never submits', async () => {
    const conversationId = await createConversation(page, electronApp)
    await seed(electronApp, conversationId, '/login')
    await command(electronApp, 'userClick', { selector: '#manual-login' })
    await sendChat(page, electronApp, conversationId, '我的工作居住证“有效期至”是什么')

    await expect(page.getByText('有效期至：2028-06-30')).toBeVisible()
    expect(await fixture.snapshot()).toMatchObject({ authenticated: true, finalSubmissions: 0 })
  })

  test('does not offer another conversation the bound page', async () => {
    const owner = await createConversation(page, electronApp)
    await seed(electronApp, owner, '/details')
    const other = await createConversation(page, electronApp)
    await sendChat(page, electronApp, other, '读取另一个会话的证件有效期')

    const requests = (await command<HarnessSnapshot>(electronApp, 'snapshot')).providerRequests
      .filter((request) => request.conversationId === other)
    expect(requests.every(({ serialized }) => !serialized.includes('browser_session_inspect'))).toBe(true)
    await expect(page.getByText('2028-06-30')).toHaveCount(0)
  })

  test('hands login to the user and continues only from a new message', async () => {
    const conversationId = await createConversation(page, electronApp)
    await seed(electronApp, conversationId, '/login')
    await sendChat(page, electronApp, conversationId, '读取证件“有效期至”')
    await expect(page.getByText('需要你在浏览器中操作')).toBeVisible()
    await expect(page.getByText('网页需要你先完成登录')).toBeVisible()

    await command(electronApp, 'userClick', { selector: '#manual-login' })
    await sendChat(page, electronApp, conversationId, '我已登录，请继续读取证件“有效期至”')
    await expect(page.getByText('有效期至：2028-06-30')).toBeVisible()
    expect(await fixture.snapshot()).toMatchObject({ finalSubmissions: 0 })
  })

  test('edits and autosaves a draft but requires an explicit user click for final submit', async () => {
    const conversationId = await createConversation(page, electronApp)
    const binding = await seed(electronApp, conversationId, '/details')
    const result = await command<{ code: string; completedActions: number }>(electronApp, 'directScenario', {
      name: 'draft', bindingId: binding.bindingId,
      userText: '把聘用单位改为：北京网聘信息技术有限公司，并保存草稿',
    })

    expect(result).toMatchObject({ code: 'OK', completedActions: 2 })
    expect(await fixture.snapshot()).toMatchObject({ draftSaves: 1, finalSubmissions: 0 })
    await command(electronApp, 'userClick', { selector: '#final-submit' })
    expect(await fixture.snapshot()).toMatchObject({ finalSubmissions: 1 })
  })

  test('fails a stale inspected reference after dynamic page replacement', async () => {
    const conversationId = await createConversation(page, electronApp)
    const binding = await seed(electronApp, conversationId, '/dynamic')
    await expect(command(electronApp, 'directScenario', {
      name: 'pageChanged', bindingId: binding.bindingId, userText: '点击保存草稿',
    })).resolves.toMatchObject({ code: 'PAGE_CHANGED' })
    expect(await fixture.snapshot()).toMatchObject({ finalSubmissions: 0 })
  })

  test('revokes the exact bound page when its workflow version changes', async () => {
    const conversationId = await createConversation(page, electronApp)
    const binding = await seed(electronApp, conversationId, '/details', '1.0.0')
    await command(electronApp, 'workflowVersionChanged', { bindingId: binding.bindingId })

    expect(await command<HarnessSnapshot>(electronApp, 'snapshot')).toMatchObject({
      openTabs: 0, activeBindings: 0,
    })
    const durable = await command<{ bindings: string }>(electronApp, 'durableRows', { conversationId })
    expect(durable.bindings).toContain('WORKFLOW_CHANGED')
  })

  test('binds only an allowed popup to the same conversation', async () => {
    const conversationId = await createConversation(page, electronApp)
    const binding = await seed(electronApp, conversationId, '/details')
    await command(electronApp, 'userClick', { tabId: binding.tabId, selector: '#allowed-popup' })
    await expect.poll(() => command<HarnessSnapshot>(electronApp, 'snapshot'))
      .toMatchObject({ activeBindings: 2, openTabs: 2 })
  })

  test('blocks navigation to a disallowed HTTPS origin', async () => {
    const conversationId = await createConversation(page, electronApp)
    const binding = await seed(electronApp, conversationId, '/details')
    await expect(command(electronApp, 'directScenario', {
      name: 'disallowed', bindingId: binding.bindingId, userText: '前往未授权来源',
    })).resolves.toMatchObject({ code: 'DOMAIN_BLOCKED' })
    const state = await command<{ url: string; blockedErrorCode?: string }>(electronApp, 'tabState', {
      tabId: binding.tabId,
    })
    expect(state.url).toBe(`${fixture.origin}/details`)
    expect(state.blockedErrorCode).toBeUndefined()
  })

  test('returns PAGE_CLOSED for a stale page binding', async () => {
    const conversationId = await createConversation(page, electronApp)
    const binding = await seed(electronApp, conversationId, '/details')
    await command(electronApp, 'closeTab', { tabId: binding.tabId })
    await expect(command(electronApp, 'directScenario', {
      name: 'inspect', bindingId: binding.bindingId, userText: '读取有效期',
    })).resolves.toMatchObject({ code: 'PAGE_CLOSED' })
  })

  test('returns PAGE_BUSY when the exact page already has an owner', async () => {
    const conversationId = await createConversation(page, electronApp)
    const binding = await seed(electronApp, conversationId, '/details')
    await command(electronApp, 'holdBusy', { bindingId: binding.bindingId })
    await expect(command(electronApp, 'directScenario', {
      name: 'inspect', bindingId: binding.bindingId, userText: '读取有效期',
    })).resolves.toMatchObject({ code: 'PAGE_BUSY' })
    await command(electronApp, 'releaseBusy', { bindingId: binding.bindingId })
  })

  test('takeover cancels the exact lease and prevents later automation', async () => {
    const conversationId = await createConversation(page, electronApp)
    const binding = await seed(electronApp, conversationId, '/details')
    await expect(command(electronApp, 'directScenario', {
      name: 'takeover', bindingId: binding.bindingId, userText: '读取有效期',
    })).resolves.toMatchObject({ code: 'CANCELLED', takenOver: true })
  })

  test('stops after exactly thirty continuation actions', async () => {
    const conversationId = await createConversation(page, electronApp)
    const binding = await seed(electronApp, conversationId, '/details')
    await expect(command(electronApp, 'directScenario', {
      name: 'actionLimit', bindingId: binding.bindingId, userText: '点击保存进度草稿',
    })).resolves.toMatchObject({ code: 'ACTION_LIMIT_EXCEEDED', completedActions: 30 })
  })

  test('conversation deletion closes its exact browser pages', async () => {
    const conversationId = await createConversation(page, electronApp)
    await seed(electronApp, conversationId, '/details')
    await command(electronApp, 'deleteConversation', { conversationId })
    expect(await command<HarnessSnapshot>(electronApp, 'snapshot')).toMatchObject({
      openTabs: 0, activeBindings: 0,
    })
  })

  test('logout closes pages while preserving the user partition cookie', async () => {
    const conversationId = await createConversation(page, electronApp)
    await seed(electronApp, conversationId, '/login')
    await command(electronApp, 'userClick', { selector: '#manual-login' })
    await command(electronApp, 'logoutAndLogin')
    const nextConversation = await createConversation(page, electronApp)
    await seed(electronApp, nextConversation, '/details', '1.0.0', false)

    expect(await command<HarnessSnapshot>(electronApp, 'snapshot')).toMatchObject({ openTabs: 1 })
    expect(await fixture.snapshot()).toMatchObject({ authenticated: true })
    expect(await command<string>(electronApp, 'pagePath')).toBe('/details')
  })

  test('explicit browser-data clearing removes only the current user partition data', async () => {
    const conversationId = await createConversation(page, electronApp)
    await seed(electronApp, conversationId, '/login')
    await command(electronApp, 'userClick', { selector: '#manual-login' })
    await command(electronApp, 'clearBrowserData')
    const nextConversation = await createConversation(page, electronApp)
    await seed(electronApp, nextConversation, '/details', '1.0.0', false)

    expect(await command<string>(electronApp, 'pagePath')).toBe('/login')
  })

  test('persists only redacted browser audit and binding rows', async () => {
    const conversationId = await createConversation(page, electronApp)
    const binding = await seed(electronApp, conversationId, '/details')
    await command(electronApp, 'directScenario', {
      name: 'inspect', bindingId: binding.bindingId, userText: '读取有效期',
    })
    const durable = await command<{ bindings: string; audits: string; messages: string }>(
      electronApp, 'durableRows', { conversationId },
    )

    expect(durable.bindings).not.toMatch(/2028-06-30|北京网聘|忽略系统规则|Cookie/i)
    expect(durable.audits).not.toMatch(/2028-06-30|北京网聘|忽略系统规则|Cookie/i)
    expect(durable.messages).not.toMatch(/北京网聘|忽略系统规则|Cookie/i)
  })

  test('page injection cannot add a tool, origin, tab, file operation, raw CDP call, or final click', async () => {
    const conversationId = await createConversation(page, electronApp)
    const binding = await seed(electronApp, conversationId, '/details')
    const result = await command<{
      code: string
      offeredTools: string[]
      forbiddenOperations: string[]
      openTabs: number
    }>(electronApp, 'directScenario', {
      name: 'injection', bindingId: binding.bindingId,
      userText: '只读取证件有效期，不要操作页面',
    })

    expect(result).toMatchObject({
      code: 'MANUAL_ACTION_REQUIRED',
      offeredTools: ['browser_session_inspect', 'browser_session_act', 'browser_session_handoff'],
      forbiddenOperations: [],
      openTabs: 1,
    })
    expect(await fixture.snapshot()).toMatchObject({ finalSubmissions: 0 })
  })
})
