import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

let application: ElectronApplication
let page: Page
let userDataDirectory: string
let workflowDirectory: string
let fixtureServer: Server
let fixturePort: number

test.beforeAll(async () => {
  userDataDirectory = mkdtempSync(join(tmpdir(), 'autoforge-e2e-'))
  workflowDirectory = mkdtempSync(join(tmpdir(), 'autoforge-workflow-e2e-'))
  fixtureServer = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><button id="ready">Ready</button>') })
  await new Promise<void>((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve))
  fixturePort = (fixtureServer.address() as AddressInfo).port
  application = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDirectory}`],
    env: { ...process.env, NODE_ENV: 'test' }
  })
  page = await application.firstWindow()
})

test.afterAll(async () => {
  await application?.close()
  await new Promise<void>((resolve) => fixtureServer.close(() => resolve()))
  rmSync(userDataDirectory, { recursive: true, force: true })
  rmSync(workflowDirectory, { recursive: true, force: true })
})

test('creates, builds and starts a local workflow through the sandbox runner', async () => {
  const targetUrl = `http://localhost:${fixturePort}`
  const result = await page.evaluate(async ({ parentDirectory, targetUrl }) => {
    const project = await window.autoForge.createWorkflowProject({ parentDirectory, manifest: {
      schemaVersion: 1, sdkVersion: 1, slug: 'e2e-workflow', name: 'E2E 工作流', description: '验证本地沙箱执行链。',
      version: '1.0.0', categorySlug: 'developer-tools', entry: 'dist/index.mjs', targetHosts: ['localhost'], permissions: ['browser.read']
    } })
    if (!project) throw new Error('Project was not created')
    return window.autoForge.debugWorkflow({ projectId: project.id, targetUrl })
  }, { parentDirectory: workflowDirectory, targetUrl })
  expect(result.status).toBe('RUNNING')
  await expect.poll(async () => (await Promise.all(application.windows().map((item) => item.url()))).some((url) => url.startsWith(targetUrl))).toBe(true)
})

test('opens Discover and navigates to Settings', async () => {
  await expect(page.getByRole('heading', { name: '发现工作流' })).toBeVisible()
  await expect(page.locator('[data-testid="primary-nav-item"]')).toHaveCount(2)
  await page.getByRole('link', { name: '设置' }).click()
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible()
})
