import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

let application: ElectronApplication
let page: Page
let userDataDirectory: string

test.beforeAll(async () => {
  userDataDirectory = mkdtempSync(join(tmpdir(), 'autoforge-e2e-'))
  application = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDirectory}`],
    env: { ...process.env, NODE_ENV: 'test' }
  })
  page = await application.firstWindow()
})

test.afterAll(async () => {
  await application?.close()
  rmSync(userDataDirectory, { recursive: true, force: true })
})

test('opens Discover and navigates to Settings', async () => {
  await expect(page.getByRole('heading', { name: '发现自动化工具' })).toBeVisible()
  await expect(page.locator('[data-testid="primary-nav-item"]')).toHaveCount(2)
  await page.getByRole('link', { name: '设置' }).click()
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible()
})
