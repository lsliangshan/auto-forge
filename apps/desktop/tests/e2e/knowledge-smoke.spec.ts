import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { expect, test, _electron, type ElectronApplication } from '@playwright/test'
import { startCloudUserDataFixture } from './cloud-user-data-sync-fixture.js'

const desktopRoot = resolve(import.meta.dirname, '../..')
const requireFromDesktop = createRequire(join(desktopRoot, 'package.json'))
const electronExecutable = requireFromDesktop('electron') as string
const e2eMain = join(desktopRoot, '.e2e/main/knowledge-smoke-main.js')

async function command<T>(application: ElectronApplication, name: string): Promise<T> {
  return application.evaluate(async ({ app }, commandName) => {
    void app
    const harness = (globalThis as typeof globalThis & {
      __AUTOFORGE_CLOUD_USER_DATA_E2E__?: {
        dispatch(name: string, input: Record<string, unknown>): Promise<unknown>
      }
    }).__AUTOFORGE_CLOUD_USER_DATA_E2E__
    if (!harness) throw new Error('Knowledge release smoke harness is unavailable')
    return harness.dispatch(commandName, {})
  }, name) as Promise<T>
}

test('runs local knowledge, degradation, expiry, and Provider-switch paths through real Electron', async () => {
  test.setTimeout(120_000)
  const fixture = await startCloudUserDataFixture()
  const userData = await mkdtemp(join(tmpdir(), 'autoforge-knowledge-release-e2e-'))
  const application = await _electron.launch({
    executablePath: electronExecutable,
    args: [e2eMain],
    env: {
      ...process.env,
      AUTOFORGE_E2E_DESKTOP_ROOT: desktopRoot,
      AUTOFORGE_E2E_USER_DATA: userData,
      AUTOFORGE_E2E_USER_DATA_FIXTURE: fixture.origin,
      AUTOFORGE_E2E_USER: 'alice',
      AUTOFORGE_E2E_KNOWLEDGE_RELEASE: '1',
    },
  })
  try {
    const page = await application.firstWindow()
    await expect(page.getByLabel('主导航')).toBeVisible()
    await command(application, 'grantCloudSync')
    await page.getByLabel('新建会话').click()
    await expect(page.getByText('新会话', { exact: true })).toBeVisible()

    await page.getByRole('link', { name: '知识库' }).click()
    await page.getByRole('button', { name: '新建', exact: true }).click()
    await page.getByRole('textbox', { name: '知识库名称' }).fill('发布门禁资料')
    await page.getByRole('button', { name: '创建', exact: true }).click()
    await page.getByRole('button', { name: '导入', exact: true }).click()
    await expect(page.getByTestId('knowledge-document-pane').getByText('可检索', { exact: true })).toBeVisible()

    const availability = await command<{
      encryption: { available: boolean }; parser: { available: boolean }; cloud: { available: boolean }
    }>(application, 'knowledgeAvailability')
    expect(availability).toMatchObject({
      encryption: { available: true }, parser: { available: true }, cloud: { available: false },
    })
    await expect(command(application, 'embeddingRefusal')).resolves.toMatchObject({
      consent: { provider: 'openrouter', status: 'unknown' },
      retrieval: { kind: 'results', evidenceCount: 1, route: 'local-keyword' },
      vectorRequests: 0,
      providerSnippetDisclosures: 0,
    })

    await page.getByRole('link', { name: '聊天' }).click()
    await page.getByTestId('knowledge-selector').locator('summary').click()
    await page.getByTestId(/knowledge-select-/).check()
    await page.getByTestId('knowledge-selector').locator('summary').click()
    await page.getByPlaceholder('描述你想完成的任务…').fill('Ask the selected knowledge base')
    await page.getByTestId('send-message').click()
    await expect(page.getByTestId('knowledge-status').filter({
      hasText: '需要授权后才能发送依据',
    })).toBeVisible()
    await page.getByTestId('grant-knowledge-consent').click()
    await page.getByPlaceholder('描述你想完成的任务…').fill('Ask the selected knowledge base')
    await page.getByTestId('send-message').click()
    await expect(page.getByTestId('knowledge-citation')).toBeVisible()
    await expect(page.getByPlaceholder('描述你想完成的任务…')).toBeEditable()

    await expect(command(application, 'expireKnowledgeEntitlement')).resolves.toMatchObject({
      entitlement: {
        tier: 'free', status: 'expired', localEnabled: true, cloudEnabled: false,
        retentionConfirmed: true,
      },
      retainedSearch: { kind: 'results', evidenceCount: 1 },
      extraSearch: { kind: 'results', evidenceCount: 0 },
      extraImport: { blocked: true, code: 'FORBIDDEN' },
      cloud: { available: false, calls: 0 },
      extrasReadOnly: true,
    })
    const switched = await command<{
      provider: string
      providerSnippetDisclosures: number
      providerSnippetDisclosureDelta: number
      consentRequired: boolean
      terminalStatus: string
    }>(
      application,
      'switchKnowledgeProvider',
    )
    expect(switched).toMatchObject({
      provider: 'deepseek', consentRequired: true, providerSnippetDisclosureDelta: 0,
      terminalStatus: 'completed',
    })
    await expect(command(application, 'deepseekKnowledgeConsent')).resolves.toMatchObject({
      provider: 'deepseek', status: 'unknown',
      providerSnippetDisclosures: switched.providerSnippetDisclosures,
    })
  } finally {
    await application.close().catch(() => undefined)
    await fixture.close()
    await rm(userData, { recursive: true, force: true })
  }
})
