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
  providerAttempts: Array<{
    conversationId: string
    name: string
    arguments: unknown
    offered: boolean
    afterInspectedPageData: boolean
  }>
  executorCalls: Array<{ conversationId: string; name: string }>
  bindingDetails: Array<{
    bindingId: string
    tabId: string
    conversationId: string
    workflowId: string
    workflowVersion: string
    source: string
    securityFingerprint: string
  }>
  highlightEvents: Array<{ conversationId: string; tabId: string; ref: string }>
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
  await submitChat(page, text)
  await command(app, 'waitForIdle', { conversationId })
}

async function submitChat(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: '消息内容' }).fill(text)
  await page.getByTestId('send-message').click()
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

  test('reads a static authenticated expiry in the same conversation and never submits', async () => {
    const conversationId = await createConversation(page, electronApp)
    await seed(electronApp, conversationId, '/login')
    await command(electronApp, 'userClick', { selector: '#manual-login' })
    await sendChat(page, electronApp, conversationId, '我的工作居住证“有效期至”是什么')

    await expect(page.getByText('工作居住证有效期：2028-06-30')).toBeVisible()
    const evidence = page.getByText(/来源：permit\.autoforge\.test \/ https:\/\/permit\.autoforge\.test；读取时间：/)
    await expect(evidence).toBeVisible()
    const readTime = (await evidence.textContent())
      ?.match(/；读取时间：(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)）。$/u)?.[1] ?? ''
    expect(Number.isFinite(Date.parse(readTime))).toBe(true)
    expect(new Date(readTime).toISOString()).toBe(readTime)
    expect(await fixture.snapshot()).toMatchObject({ authenticated: true, finalSubmissions: 0 })
  })

  test('does not offer another conversation the bound page', async () => {
    const owner = await createConversation(page, electronApp)
    const ownerBinding = await seed(electronApp, owner, '/details')
    expect(await command<HarnessSnapshot>(electronApp, 'snapshot')).toMatchObject({
      activeBindings: 1,
      bindingDetails: [expect.objectContaining({
        bindingId: ownerBinding.bindingId,
        conversationId: owner,
      })],
    })
    const other = await createConversation(page, electronApp)
    await sendChat(page, electronApp, other, '读取另一个会话的证件有效期')

    const requests = (await command<HarnessSnapshot>(electronApp, 'snapshot')).providerRequests
      .filter((request) => request.conversationId === other)
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every(({ serialized }) => !serialized.includes('browser_session_inspect'))).toBe(true)
    expect(await command<HarnessSnapshot>(electronApp, 'snapshot')).toMatchObject({
      activeBindings: 1,
      bindingDetails: [expect.objectContaining({ conversationId: owner })],
    })
    await expect(page.getByText('2028-06-30')).toHaveCount(0)
  })

  test('hands login to the user and continues only from a new message', async () => {
    const conversationId = await createConversation(page, electronApp)
    await seed(electronApp, conversationId, '/login')
    await sendChat(page, electronApp, conversationId, '读取证件“有效期至”')
    await expect(page.getByText('需要你在浏览器中操作')).toBeVisible()
    await expect(page.getByText('网页需要你先完成登录')).toBeVisible()

    const beforeLoginClick = (await command<HarnessSnapshot>(electronApp, 'snapshot')).providerRequests.length
    await command(electronApp, 'userClick', { selector: '#manual-login' })
    await expect.poll(async () => (await fixture.snapshot()).authenticated).toBe(true)
    await page.waitForTimeout(500)
    expect((await command<HarnessSnapshot>(electronApp, 'snapshot')).providerRequests).toHaveLength(beforeLoginClick)
    await expect(page.getByText('工作居住证有效期：2028-06-30')).toHaveCount(0)
    await sendChat(page, electronApp, conversationId, '我已登录，请继续读取证件“有效期至”')
    await expect(page.getByText('工作居住证有效期：2028-06-30')).toBeVisible()
    expect(await fixture.snapshot()).toMatchObject({ finalSubmissions: 0 })
  })

  test('edits and autosaves a draft but requires an explicit user click for final submit', async () => {
    const conversationId = await createConversation(page, electronApp)
    const binding = await seed(electronApp, conversationId, '/details')
    await sendChat(
      page,
      electronApp,
      conversationId,
      '填写聘用单位：北京网聘信息技术有限公司，并点击保存草稿 E2E_DRAFT',
    )

    const draftAttempt = (await command<HarnessSnapshot>(electronApp, 'snapshot')).providerAttempts
      .find((attempt) => attempt.conversationId === conversationId && attempt.name === 'browser_session_act')
    expect(draftAttempt).toMatchObject({ offered: true, afterInspectedPageData: true })
    expect(draftAttempt?.arguments).toEqual(expect.objectContaining({
      actions: [
        expect.objectContaining({ type: 'fill', source: { kind: 'current_user' } }),
        expect.objectContaining({ type: 'click' }),
      ],
    }))
    expect(await command<string>(electronApp, 'tabFieldValue', {
      tabId: binding.tabId, selector: '#employer',
    })).toBe('北京网聘信息技术有限公司')
    await expect.poll(async () => fixture.snapshot(), {
      message: 'the draft beacon should persist the exact replacement before final submit',
      timeout: 5_000,
    }).toMatchObject({
      employer: '北京网聘信息技术有限公司',
      lastDraftPayload: '北京网聘信息技术有限公司',
      draftSaves: 1,
      finalSubmissions: 0,
    })
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

  test('revokes the exact bound page across a real same-version reinstall', async () => {
    const conversationId = await createConversation(page, electronApp)
    const binding = await seed(electronApp, conversationId, '/details', '1.0.0')
    const reinstalled = await command<{
      workflowId: string
      workflowVersion: string
      securityFingerprint: string
    }>(electronApp, 'reinstallFixtureWorkflow', { bindingId: binding.bindingId })

    expect(await command<HarnessSnapshot>(electronApp, 'snapshot')).toMatchObject({
      openTabs: 0, activeBindings: 0,
    })
    expect(reinstalled).toMatchObject({
      workflowId: 'e2e.browser.workflow', workflowVersion: '1.0.0',
      securityFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
    const durable = await command<{ bindings: string }>(electronApp, 'durableRows', { conversationId })
    expect(durable.bindings).toContain('WORKFLOW_CHANGED')
  })

  test('binds only an allowed popup to the same conversation', async () => {
    const conversationId = await createConversation(page, electronApp)
    const binding = await seed(electronApp, conversationId, '/details')
    const parentFingerprint = (await command<HarnessSnapshot>(electronApp, 'snapshot'))
      .bindingDetails.find(({ bindingId }) => bindingId === binding.bindingId)?.securityFingerprint
    expect(parentFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    await command(electronApp, 'userClick', { tabId: binding.tabId, selector: '#allowed-popup' })
    await expect.poll(() => command<HarnessSnapshot>(electronApp, 'snapshot')).toMatchObject({
      activeBindings: 2,
      openTabs: 2,
      bindingDetails: [
        expect.objectContaining({
          conversationId,
          workflowId: 'e2e.browser.workflow',
          workflowVersion: '1.0.0',
          source: 'installed',
          securityFingerprint: parentFingerprint,
        }),
        expect.objectContaining({
          conversationId,
          workflowId: 'e2e.browser.workflow',
          workflowVersion: '1.0.0',
          source: 'installed',
          securityFingerprint: parentFingerprint,
        }),
      ],
    })
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

  test("explicit browser-data clearing removes the active test user's partition cookie", async () => {
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

  test('Main boundary hands a protected final action to the user without clicking it', async () => {
    const conversationId = await createConversation(page, electronApp)
    const binding = await seed(electronApp, conversationId, '/details')
    const result = await command<{ code: string }>(electronApp, 'directScenario', {
      name: 'injection', bindingId: binding.bindingId,
      userText: '只读取证件有效期，不要操作页面',
    })

    expect(result).toMatchObject({ code: 'MANUAL_ACTION_REQUIRED' })
    expect(await fixture.snapshot()).toMatchObject({ finalSubmissions: 0 })
  })

  test('Renderer chat and the deterministic provider cannot turn inspected injection text into new authority', async () => {
    const conversationId = await createConversation(page, electronApp)
    const binding = await seed(electronApp, conversationId, '/details')
    const cases = [
      ['E2E_INJECT_OPEN_TAB', 'browser_session_open_tab'],
      ['E2E_INJECT_UPLOAD_FILE', 'browser_session_upload_file'],
      ['E2E_INJECT_RAW_CDP', 'browser_session_raw_cdp'],
      ['E2E_INJECT_DISALLOWED_ORIGIN', 'browser_session_act'],
      ['E2E_INJECT_FINAL_CLICK', 'browser_session_act'],
    ] as const

    for (const [marker] of cases) {
      await sendChat(page, electronApp, conversationId, `只读取证件有效期，不要操作页面 ${marker}`)
    }

    const snapshot = await command<HarnessSnapshot>(electronApp, 'snapshot')
    const attempts = snapshot.providerAttempts.filter((attempt) => attempt.conversationId === conversationId)
    expect(attempts).toHaveLength(cases.length)
    expect(attempts.map(({ name }) => name)).toEqual(cases.map(([, name]) => name))
    expect(attempts.every(({ afterInspectedPageData }) => afterInspectedPageData)).toBe(true)
    expect(attempts.slice(0, 3).every(({ offered }) => !offered)).toBe(true)
    expect(attempts.slice(3).every(({ offered }) => offered)).toBe(true)
    expect(attempts[3]!.arguments).toEqual(expect.objectContaining({
      actions: [expect.objectContaining({
        type: 'navigate', url: `${fixture.disallowedOrigin}/landing`,
        source: expect.objectContaining({ kind: 'page' }),
      })],
    }))
    expect(attempts[4]!.arguments).toEqual(expect.objectContaining({
      actions: [expect.objectContaining({ type: 'click' })],
    }))
    expect(snapshot.executorCalls.filter(({ conversationId: owner }) => owner === conversationId)
      .map(({ name }) => name)).toEqual(Array.from({ length: cases.length }, () => 'browser_session_inspect'))
    expect(snapshot.openTabs).toBe(1)
    expect(snapshot.activeBindings).toBe(1)
    expect((await command<{ url: string }>(electronApp, 'tabState', { tabId: binding.tabId })).url)
      .toBe(`${fixture.origin}/details`)
    expect(await fixture.snapshot()).toMatchObject({ fileSelections: 0, finalSubmissions: 0 })
  })

  test('normal workflow origin drives the complete chain and visible browser controls', async () => {
    const conversationId = await createConversation(page, electronApp)
    await submitChat(page, '运行工作居住证完整链路 E2E_WORKFLOW_OPEN')
    await expect(page.getByText('需要授权').last()).toBeVisible()
    await expect(page.getByText('browser.fill').last()).toBeVisible()
    await page.getByTestId('approve-once').last().click()
    await expect(page.getByText('browser.click').last()).toBeVisible()
    await page.getByTestId('approve-once').last().click()
    await command(electronApp, 'waitForIdle', { conversationId })
    await expect(page.getByText(/调用完成.*E2E 工作居住证/).last()).toBeVisible()

    const originated = await command<HarnessSnapshot>(electronApp, 'snapshot')
    expect(originated).toMatchObject({
      activeBindings: 1,
      bindingDetails: [expect.objectContaining({
        conversationId,
        workflowId: 'e2e.browser.workflow',
        workflowVersion: '1.0.0',
        source: 'installed',
      })],
    })

    await sendChat(page, electronApp, conversationId, '请点击正式提交 E2E_PROTECTED_HIGHLIGHT')
    const highlighted = await command<HarnessSnapshot>(electronApp, 'snapshot')
    expect(highlighted.providerAttempts).toContainEqual(expect.objectContaining({
      conversationId,
      name: 'browser_session_act',
      offered: true,
      afterInspectedPageData: true,
    }))
    const protectedCard = page.getByTestId('browser-status').last()
    await expect(protectedCard.getByText('需要你在浏览器中操作')).toBeVisible()
    expect(highlighted.highlightEvents).toContainEqual(expect.objectContaining({ conversationId }))
    await protectedCard.getByText('查看操作记录').click()
    await expect(protectedCard.getByTestId('browser-audit-entry')).toHaveCount(3)
    await expect(protectedCard).toContainText('https://permit.autoforge.test')
    await expect(protectedCard).toContainText('已交由你操作')
    await expect(protectedCard).not.toContainText('2028-06-30')

    await command(electronApp, 'pauseNextInspection')
    await submitChat(page, '读取证件有效期 E2E_PAUSE_FOR_STOP')
    const stopCard = page.getByTestId('browser-status').last()
    await expect(stopCard.getByText('AI 正在读取网页')).toBeVisible()
    await stopCard.getByTestId('stop-browser').click()
    await expect(stopCard.getByTestId('stop-browser')).toBeDisabled()
    await command(electronApp, 'releaseInspection')
    await command(electronApp, 'waitForIdle', { conversationId })
    await expect(stopCard.getByText('浏览器自动操作已停止')).toBeVisible()

    await command(electronApp, 'pauseNextInspection')
    await submitChat(page, '读取证件有效期 E2E_PAUSE_FOR_TAKEOVER')
    const takeoverCard = page.getByTestId('browser-status').last()
    await expect(takeoverCard.getByText('AI 正在读取网页')).toBeVisible()
    await takeoverCard.getByTestId('take-over-browser').click()
    await expect(takeoverCard.getByTestId('take-over-browser')).toBeDisabled()
    await command(electronApp, 'releaseInspection')
    await command(electronApp, 'waitForIdle', { conversationId })
    await expect(takeoverCard.getByText('浏览器自动操作已停止')).toBeVisible()
    expect(await fixture.snapshot()).toMatchObject({ finalSubmissions: 0 })
  })
})
