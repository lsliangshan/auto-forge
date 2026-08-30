import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import {
  startCloudUserDataFixture,
  type CloudUserDataFixture,
} from './cloud-user-data-sync-fixture.js'

const desktopRoot = resolve(import.meta.dirname, '../..')
const requireFromDesktop = createRequire(join(desktopRoot, 'package.json'))
const electronExecutable = requireFromDesktop('electron') as string
const e2eMain = join(desktopRoot, '.e2e/main/cloud-user-data-sync-main.js')

interface LaunchedProfile {
  app: ElectronApplication
  page: Page
  userData: string
}

async function command<T>(
  application: ElectronApplication,
  name: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  return application.evaluate(async ({ app }, payload) => {
    void app
    const harness = (globalThis as typeof globalThis & {
      __AUTOFORGE_CLOUD_USER_DATA_E2E__?: {
        dispatch(name: string, input: Record<string, unknown>): Promise<unknown>
      }
    }).__AUTOFORGE_CLOUD_USER_DATA_E2E__
    if (!harness) throw new Error('Cloud user-data E2E harness is unavailable')
    return harness.dispatch(payload.name, payload.input)
  }, { name, input }) as Promise<T>
}

async function launchProfile(
  fixture: CloudUserDataFixture,
  user: 'alice' | 'bob' = 'alice',
  options: { seedLegacy?: boolean } = {},
): Promise<LaunchedProfile> {
  const userData = await mkdtemp(join(tmpdir(), 'autoforge-cloud-user-data-e2e-'))
  const application = await _electron.launch({
    executablePath: electronExecutable,
    args: [e2eMain],
    env: {
      ...process.env,
      AUTOFORGE_E2E_DESKTOP_ROOT: desktopRoot,
      AUTOFORGE_E2E_USER_DATA: userData,
      AUTOFORGE_E2E_USER_DATA_FIXTURE: fixture.origin,
      AUTOFORGE_E2E_USER: user,
      ...(options.seedLegacy ? { AUTOFORGE_E2E_SEED_LEGACY: '1' } : {}),
    },
  })
  const page = await application.firstWindow()
  await expect(page.getByLabel('主导航')).toBeVisible()
  return { app: application, page, userData }
}

async function grantCloudSync(
  fixture: CloudUserDataFixture,
  profile: LaunchedProfile,
): Promise<void> {
  await command(profile.app, 'grantCloudSync')
  await expect.poll(() => fixture.snapshot('alice')).toMatchObject({ consentCount: 1 })
  await expect.poll(() => command<number>(profile.app, 'pendingOutbox')).toBe(0)
}

async function createNamedConversation(profile: LaunchedProfile, title: string): Promise<string> {
  await profile.page.getByLabel('新建会话').click()
  const enableDialog = profile.page.getByRole('dialog', { name: '开启账户云同步' })
  if (await enableDialog.isVisible().catch(() => false)) {
    await enableDialog.getByRole('button', { name: '同意并创建' }).click()
  }
  const id = await command<string>(profile.app, 'selectedConversation')
  await expect.poll(() => command<number>(profile.app, 'pendingOutbox')).toBe(0)
  const conversation = profile.page.getByRole('button', { name: '新会话', exact: true })
  await expect(conversation).toBeVisible()
  await expect(profile.page.getByRole('status', { name: '同步完成' })).toHaveCount(0)
  await conversation.hover()
  await profile.page.getByRole('button', { name: '重命名新会话' }).click()
  const dialog = profile.page.getByRole('dialog', { name: '重命名会话' })
  await dialog.getByRole('textbox').fill(title)
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(profile.page.getByText(title, { exact: true })).toBeVisible()
  await expect.poll(() => command<number>(profile.app, 'pendingOutbox')).toBe(0)
  await expect(profile.page.getByRole('button', { name: title, exact: true })).toBeVisible()
  await expect(profile.page.getByRole('status', { name: '同步完成' })).toHaveCount(0)
  return id
}

async function deleteConversation(profile: LaunchedProfile, title: string): Promise<void> {
  const conversation = profile.page.getByRole('button', { name: title, exact: true })
  await expect(conversation).toBeVisible()
  await conversation.hover()
  await profile.page.getByRole('button', { name: `删除${title}` }).click()
  const dialog = profile.page.getByRole('dialog', { name: '删除会话' })
  await dialog.getByRole('button', { name: '确认删除' }).click()
  await expect(profile.page.getByText(title, { exact: true })).toHaveCount(0)
}

async function switchUser(profile: LaunchedProfile, user: 'alice' | 'bob'): Promise<void> {
  await command(profile.app, 'switchUser', { user })
  await profile.page.reload()
  await expect(profile.page.getByLabel('主导航')).toBeVisible()
}

async function assertImportedTranscriptVisible(profile: LaunchedProfile): Promise<void> {
  await profile.page.goto(`file://${join(desktopRoot, 'out/renderer/index.html')}#/chat`)
  await profile.page.reload()
  const conversation = profile.page.getByRole('button', { name: '本机未归属历史', exact: true })
  await expect(conversation).toBeVisible()
  await conversation.click()

  const messages = profile.page.locator('article.message')
  await expect(messages).toHaveCount(99)
  await expect(profile.page.getByText('历史消息 1', { exact: true })).toBeVisible()
  await expect(profile.page.getByText('历史消息 50', { exact: true })).toBeVisible()
  await expect(profile.page.getByText('历史消息 99', { exact: true })).toBeVisible()
  await expect(profile.page.getByRole('button', { name: '加载更早消息' })).toHaveCount(0)
}

test.describe.serial('CloudBase conversation sync milestone', () => {
  test.setTimeout(60_000)

  let fixture: CloudUserDataFixture
  const profiles: LaunchedProfile[] = []

  test.beforeAll(async () => {
    fixture = await startCloudUserDataFixture()
  })

  test.beforeEach(async () => {
    await fixture.reset()
  })

  test.afterEach(async () => {
    for (const profile of profiles.splice(0)) {
      await profile.app.close().catch(() => undefined)
      await rm(profile.userData, { recursive: true, force: true })
    }
  })

  test.afterAll(async () => {
    await fixture?.close()
  })

  test('keeps Alice and Bob isolated through one machine profile lifecycle', async () => {
    const profile = await launchProfile(fixture)
    profiles.push(profile)
    await grantCloudSync(fixture, profile)
    await createNamedConversation(profile, 'Alice 私有会话')
    await expect.poll(() => fixture.snapshot('alice')).toMatchObject({
      conversations: [expect.objectContaining({ title: 'Alice 私有会话', deleted: false })],
    })

    await switchUser(profile, 'bob')
    await expect(profile.page.getByText('Alice 私有会话')).toHaveCount(0)
    await createNamedConversation(profile, 'Bob 私有会话')
    await expect.poll(() => fixture.snapshot('bob')).toMatchObject({
      conversations: [expect.objectContaining({ title: 'Bob 私有会话', deleted: false })],
    })

    await switchUser(profile, 'alice')
    await expect(profile.page.getByText('Alice 私有会话')).toBeVisible()
    await expect(profile.page.getByText('Bob 私有会话')).toHaveCount(0)
  })

  test('uses the real window bridge to create, import, select, and reload a ready knowledge base', async () => {
    const profile = await launchProfile(fixture)
    profiles.push(profile)
    await grantCloudSync(fixture, profile)
    await profile.page.getByLabel('新建会话').click()
    await expect(profile.page.getByText('新会话', { exact: true })).toBeVisible()
    await expect.poll(() => command<number>(profile.app, 'pendingOutbox')).toBe(0)

    await profile.page.getByRole('link', { name: '知识库' }).click()
    await expect(profile.page.getByTestId('knowledge-workspace')).toBeVisible()
    await profile.page.getByTestId('knowledge-create-toggle').click()
    await profile.page.getByRole('textbox', { name: '知识库名称' }).fill('个人资料')
    await profile.page.getByRole('button', { name: '创建', exact: true }).click()
    await expect(profile.page.getByText('个人资料', { exact: true })).toBeVisible()
    await profile.page.getByTestId('knowledge-import').click()
    const knowledgeTree = profile.page.getByTestId('knowledge-tree')
    await expect(knowledgeTree.getByText('e2e-guide.txt', { exact: true })).toBeVisible()
    await expect(knowledgeTree.getByTestId(/^knowledge-document-/).getByText('可检索', { exact: true })).toBeVisible()

    await profile.page.getByRole('link', { name: '聊天' }).click()
    await profile.page.getByTestId('knowledge-selector').locator('summary').click()
    await expect(profile.page.getByTestId(/knowledge-select-/)).not.toBeChecked()
    await profile.page.getByTestId(/knowledge-select-/).check()
    await expect.poll(() => command<number>(profile.app, 'pendingOutbox')).toBe(0)

    await profile.page.reload()
    await expect(profile.page.getByLabel('主导航')).toBeVisible()
    await profile.page.getByTestId('knowledge-selector').locator('summary').click()
    await expect(profile.page.getByTestId(/knowledge-select-/)).toBeChecked()
    await profile.page.getByTestId('knowledge-selector').locator('summary').click()

    await profile.page.getByPlaceholder('描述你想完成的任务…').fill('Ask the selected knowledge base')
    await profile.page.getByTestId('send-message').click()
    await expect(profile.page.getByTestId('knowledge-status')).toContainText('需要授权后才能发送依据')
    await profile.page.getByTestId('grant-knowledge-consent').click()
    await expect(profile.page.getByText('已授权，请重新发送问题。')).toBeVisible()
    await profile.page.getByPlaceholder('描述你想完成的任务…').fill('Ask the selected knowledge base')
    await profile.page.getByTestId('send-message').click()
    await expect(profile.page.getByTestId('knowledge-status').last()).toContainText('已找到 1 条依据')
    const citation = profile.page.getByTestId('knowledge-citation')
    await expect(citation).toBeVisible()
    await citation.getByTestId('toggle-knowledge-preview').click()
    await expect(citation.getByTestId('knowledge-source-preview')).toContainText('AutoForge knowledge smoke')
  })

  test('converges Alice across two independent app profiles', async () => {
    const first = await launchProfile(fixture)
    profiles.push(first)
    await grantCloudSync(fixture, first)
    await createNamedConversation(first, 'Alice 双设备会话')
    await expect.poll(() => fixture.snapshot('alice')).toMatchObject({
      conversations: [expect.objectContaining({ title: 'Alice 双设备会话' })],
    })

    const second = await launchProfile(fixture)
    profiles.push(second)
    await expect(second.page.getByText('Alice 双设备会话')).toBeVisible()
    await expect(first.page.getByText('Alice 双设备会话')).toBeVisible()
    expect(first.userData).not.toBe(second.userData)
  })

  test('loads the next opaque cursor page in the visible conversation list', async () => {
    await fixture.seedConversations('alice', 55, '分页会话')
    const profile = await launchProfile(fixture)
    profiles.push(profile)

    await expect(profile.page.getByRole('button', { name: /^分页会话 \d{2}$/u })).toHaveCount(50)
    await profile.page.getByRole('button', { name: '加载更多会话' }).click()
    await expect(profile.page.getByRole('button', { name: /^分页会话 \d{2}$/u })).toHaveCount(55)
    await expect(profile.page.getByRole('button', { name: '加载更多会话' })).toHaveCount(0)
  })

  test('replays an offline outbox and removes the visible sync indicator after completion', async () => {
    const profile = await launchProfile(fixture)
    profiles.push(profile)
    await grantCloudSync(fixture, profile)
    await fixture.setOnline('alice', false)

    await profile.page.getByLabel('新建会话').click()
    const row = profile.page.getByRole('button', { name: /^新会话 /u })
    await expect(row).toBeVisible()
    await expect(row.getByRole('status', { name: '等待同步' })).toBeVisible()

    await fixture.setOnline('alice', true)
    await expect.poll(() => fixture.snapshot('alice')).toMatchObject({
      conversations: [expect.objectContaining({ title: '新会话', deleted: false })],
    })
    await expect(profile.page.getByRole('button', { name: '新会话', exact: true })).toBeVisible()
    await expect(profile.page.getByRole('status', { name: '同步完成' })).toHaveCount(0)
  })

  test('retries an ambiguous push as a duplicate without duplicating the conversation', async () => {
    const profile = await launchProfile(fixture)
    profiles.push(profile)
    await grantCloudSync(fixture, profile)
    await fixture.failAfterApplyOnce('alice')

    await profile.page.getByLabel('新建会话').click()
    await expect(profile.page.getByText('新会话', { exact: true })).toBeVisible()
    await expect.poll(() => fixture.snapshot('alice')).toMatchObject({
      conversations: [expect.objectContaining({ title: '新会话' })],
      duplicateMutationCount: expect.any(Number),
    })
    await expect.poll(async () => (await fixture.snapshot('alice')).duplicateMutationCount)
      .toBeGreaterThan(0)
    await expect(profile.page.getByRole('button', { name: '新会话', exact: true })).toBeVisible()
    await expect(profile.page.getByRole('status', { name: '同步完成' })).toHaveCount(0)
    expect((await fixture.snapshot('alice')).conversations).toHaveLength(1)
  })

  test('reconciles a lost response after purge and rejects changed-content mutation reuse', async () => {
    const profile = await launchProfile(fixture)
    profiles.push(profile)
    await grantCloudSync(fixture, profile)
    await fixture.failAfterApplyAndPurgeOnce('alice')

    await profile.page.getByLabel('新建会话').click()

    await expect.poll(() => fixture.snapshot('alice')).toMatchObject({
      conversations: [],
      duplicateMutationCount: expect.any(Number),
      compactedConversationEventCount: 2,
      retainedConversationPayloadCount: 0,
    })
    await expect.poll(async () => (await fixture.snapshot('alice')).duplicateMutationCount)
      .toBeGreaterThan(0)
    await expect.poll(() => command<number>(profile.app, 'pendingOutbox')).toBe(0)
    await expect.poll(() => command<number>(profile.app, 'receiptEvidenceCount')).toBe(0)
    await expect(profile.page.getByText('新会话', { exact: true })).toHaveCount(0)

    await expect(fixture.retryPurgedMutationWithChangedContent('alice')).resolves.toMatchObject({
      status: 'rejected', errorCode: 'INVALID_INPUT',
    })
    await expect.poll(() => fixture.snapshot('alice')).toMatchObject({
      conversations: [],
      compactedConversationEventCount: 2,
      retainedConversationPayloadCount: 0,
    })
  })

  test('propagates a tombstone to Alice on the second profile', async () => {
    const first = await launchProfile(fixture)
    profiles.push(first)
    await grantCloudSync(fixture, first)
    await createNamedConversation(first, '跨设备删除会话')
    await expect.poll(() => fixture.snapshot('alice')).toMatchObject({
      conversations: [expect.objectContaining({ title: '跨设备删除会话', deleted: false })],
    })
    const second = await launchProfile(fixture)
    profiles.push(second)
    await expect(second.page.getByText('跨设备删除会话')).toBeVisible()

    await deleteConversation(first, '跨设备删除会话')
    await expect.poll(() => fixture.snapshot('alice')).toMatchObject({
      conversations: [expect.objectContaining({ title: '跨设备删除会话', deleted: true })],
    })
    await expect.poll(() => command(second.app, 'refreshConversations')).toBe(true)
    await expect(second.page.getByText('跨设备删除会话')).toHaveCount(0)
  })

  test('requires both visible confirmations before importing unowned legacy history', async () => {
    const profile = await launchProfile(fixture, 'alice', { seedLegacy: true })
    profiles.push(profile)
    await profile.page.goto(`file://${join(desktopRoot, 'out/renderer/index.html')}#/settings`)
    await expect(profile.page.getByText('未归属 1 条')).toBeVisible()

    await profile.page.getByTestId('legacy-import-button').click()
    await profile.page.getByRole('dialog', { name: '开启账户云同步' })
      .getByRole('button', { name: '同意并继续' }).click()
    await profile.page.getByRole('dialog', { name: '确认迁移未归属会话' })
      .getByRole('button', { name: '确认迁移' }).click()
    await expect(profile.page.getByText('历史会话迁移完成')).toBeVisible()
    await expect.poll(() => fixture.snapshot('alice')).toMatchObject({
      consentCount: 2,
      importedBatchCount: 1,
      conversations: [expect.objectContaining({ title: '本机未归属历史', deleted: false })],
    })
    const currentProfileSnapshot = await fixture.snapshot('alice')
    expect(currentProfileSnapshot.pullPageSizes.some((size, index, pages) => (
      size === 100 && pages[index + 1] === 1
    ))).toBe(true)
    await assertImportedTranscriptVisible(profile)

    const second = await launchProfile(fixture)
    profiles.push(second)
    await assertImportedTranscriptVisible(second)
  })

  test('shows BYOK estimates and unavailable costs without confirmed platform spend', async () => {
    await fixture.seedByokUsage('alice')
    const profile = await launchProfile(fixture)
    profiles.push(profile)
    await profile.page.goto(`file://${join(desktopRoot, 'out/renderer/index.html')}#/settings`)

    const summary = profile.page.getByTestId('remote-usage-summary')
    await expect(summary).toContainText('BYOK 估算')
    await expect(summary).toContainText('$0.01 · 1 笔')
    await expect(summary).toContainText('BYOK 费用不可用1 笔')
    await expect(summary).toContainText('平台已确认消费—')
    await expect(summary).not.toContainText('BYOK 已确认')
    expect(await command<number>(profile.app, 'providerRequestCount')).toBe(0)
  })
})
