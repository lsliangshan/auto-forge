import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { test, expect, _electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'

const repositoryRoot = resolve(import.meta.dirname, '../../../..')
const desktopRoot = resolve(import.meta.dirname, '../..')
const requireFromDesktop = createRequire(join(desktopRoot, 'package.json'))
const electronExecutable = requireFromDesktop('electron') as string
const e2eMain = join(desktopRoot, '.e2e/main/universal-file-converter-fixture.js')
const artifactRoot = join(repositoryRoot, '.test-artifacts/task-14-universal-file-converter')
const profileRoot = join(artifactRoot, 'profiles')
const bundleRoot = process.env.AUTOFORGE_TEST_CONVERTER_PACK_ROOT
const externalGate = 'EXTERNAL GATE: set AUTOFORGE_TEST_CONVERTER_PACK_ROOT to an absolute signed Task 13 fixture bundle; local fixture evidence is not production release acceptance.'
const enabled = typeof bundleRoot === 'string' && isAbsolute(bundleRoot)

if (!enabled) console.warn(externalGate)

interface JobView {
  jobId: string
  executionId: string
  targetFormat: string
  status: string
  epoch: number
  progress: number
  errorCode?: string
  artifacts: Array<{
    artifactId: string
    status: string
    displayName: string
    detectedFormat: string
    byteSize: number
  }>
}

interface HarnessSnapshot {
  providerRequests: Array<{ serialized: string; workflowToolName?: string; workflowCalls: number }>
  developerRuns: Array<{
    projectId: string
    input: { files: number[]; targetFormat: string }
    attachmentIds?: string[]
  }>
  nativePickerNames: string[][]
  saveDialogDefaults: string[]
  revealedCount: number
  previewedCount: number
  heldJobIds: string[]
  processEvidence: Array<{
    jobId: string
    epoch: number
    pack: string
    targetFormat: string
    processExited: true
  }>
  jobs: JobView[]
}

interface LaunchedProfile {
  app: ElectronApplication
  page: Page
  userData: string
}

interface LaunchProfileOptions {
  userData?: string
  packRoot?: string
  env?: NodeJS.ProcessEnv
}

async function command<T>(
  application: ElectronApplication,
  name: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  return application.evaluate(async ({ app }, payload) => {
    void app
    const harness = (globalThis as typeof globalThis & {
      __AUTOFORGE_UNIVERSAL_CONVERTER_E2E__?: {
        dispatch(name: string, input: Record<string, unknown>): Promise<unknown>
      }
    }).__AUTOFORGE_UNIVERSAL_CONVERTER_E2E__
    if (!harness) throw new Error('Universal converter E2E harness is unavailable')
    return harness.dispatch(payload.name, payload.input)
  }, { name, input }) as Promise<T>
}

async function launchProfile(options: LaunchProfileOptions = {}): Promise<LaunchedProfile> {
  await mkdir(profileRoot, { recursive: true })
  const profile = options.userData ?? await mkdtemp(join(profileRoot, 'profile-'))
  await mkdir(profile, { recursive: true })
  const application = await _electron.launch({
    executablePath: electronExecutable,
    args: [e2eMain],
    env: {
      ...process.env,
      AUTOFORGE_E2E_DESKTOP_ROOT: desktopRoot,
      AUTOFORGE_E2E_REPOSITORY_ROOT: repositoryRoot,
      AUTOFORGE_E2E_USER_DATA: profile,
      AUTOFORGE_TEST_CONVERTER_PACK_ROOT: options.packRoot ?? bundleRoot!,
      ...options.env,
    },
  })
  const stderr: string[] = []
  application.process().stderr?.on('data', (chunk) => { stderr.push(String(chunk)) })
  let page: Page
  try {
    page = await application.firstWindow()
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr.join('')}`, { cause: error })
  }
  await expect(page.getByLabel('主导航')).toBeVisible({ timeout: 30_000 })
  return { app: application, page, userData: profile }
}

async function createConversation(profile: LaunchedProfile): Promise<string> {
  await profile.page.getByRole('button', { name: '新建会话' }).first().click()
  const syncDialog = profile.page.getByRole('dialog', { name: '开启账户云同步' })
  if (await syncDialog.isVisible().catch(() => false)) {
    await syncDialog.getByRole('button', { name: '同意并创建' }).click()
  }
  await expect(profile.page.getByTestId('attach-media')).toBeVisible()
  return command<string>(profile.app, 'selectedConversation')
}

async function submitChat(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: '消息内容' }).fill(text)
  await page.getByTestId('send-message').click()
}

async function attachFixtureFiles(profile: LaunchedProfile, names: string[]): Promise<void> {
  await command(profile.app, 'setPickerFiles', { names })
  await profile.page.getByTestId('attach-media').click()
  await expect(profile.page.getByTestId('attachment-card')).toHaveCount(names.length)
}

async function replaceMonacoContent(page: Page, content: string): Promise<void> {
  const input = page.getByRole('textbox', { name: 'Editor content' })
  await input.focus()
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText(content)
}

async function screenshot(page: Page, name: string): Promise<void> {
  await mkdir(artifactRoot, { recursive: true })
  await page.screenshot({ path: join(artifactRoot, `${name}.png`), fullPage: true })
}

async function screenshotElement(locator: Locator, name: string): Promise<void> {
  await mkdir(artifactRoot, { recursive: true })
  await locator.screenshot({ path: join(artifactRoot, `${name}.png`) })
}

async function captureElectronPage(profile: LaunchedProfile, name: string): Promise<void> {
  const base64 = await command<string>(profile.app, 'capturePage')
  await writeFile(join(artifactRoot, `${name}.png`), Buffer.from(base64, 'base64'))
}

function expectIco(bytes: Buffer): void {
  expect(bytes.byteLength).toBeGreaterThan(6)
  expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]))
  expect(bytes.readUInt16LE(4)).toBeGreaterThan(0)
}

function expectPdf(bytes: Buffer): void {
  expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-')
  expect(bytes.subarray(Math.max(0, bytes.byteLength - 1_024)).toString('latin1')).toContain('%%EOF')
}

test.describe.serial('universal file conversion through Electron', () => {
  test.skip(!enabled, externalGate)
  test.setTimeout(180_000)

  const launchedProfiles: LaunchedProfile[] = []
  const cleanupRoots = new Set<string>()

  test.beforeAll(async () => {
    await rm(artifactRoot, { recursive: true, force: true })
    await mkdir(artifactRoot, { recursive: true })
  })

  test.afterEach(async () => {
    for (const profile of launchedProfiles.splice(0)) {
      await profile.app.close().catch(() => undefined)
      cleanupRoots.add(profile.userData)
    }
    for (const root of cleanupRoots) await rm(root, { recursive: true, force: true })
    cleanupRoots.clear()
  })

  test('fails closed on combined targets, then converts PNG and DOCX through exact approvals', async () => {
    const profile = await launchProfile()
    launchedProfiles.push(profile)
    const conversationId = await createConversation(profile)
    await attachFixtureFiles(profile, ['transparent-nonsquare.png', 'sample.docx'])
    await expect(profile.page.getByTestId('attachment-card').nth(0)).toContainText('transparent-nonsquare.png')
    await expect(profile.page.getByTestId('attachment-card').nth(1)).toContainText('sample.docx')

    await submitChat(profile.page, '把图片转成 favicon ico，把文档转成 PDF')
    await expect(profile.page.getByText('请确认要转换哪个附件，以及希望转换成什么格式。我尚未读取或转换附件内容。'))
      .toBeVisible()
    await expect(profile.page.getByTestId('approval-card')).toHaveCount(0)
    await command(profile.app, 'waitForIdle', { conversationId })

    await attachFixtureFiles(profile, ['transparent-nonsquare.png', 'sample.docx'])
    await submitChat(profile.page, '把 transparent-nonsquare.png 转成 ico')

    const firstApproval = profile.page.getByTestId('approval-card').filter({ hasText: '目标格式：ico' })
    await expect(firstApproval).toBeVisible()
    await expect(firstApproval).toContainText('附件 0：transparent-nonsquare.png')
    await expect(firstApproval).not.toContainText('附件 1')
    await expect(profile.page.getByTestId('approve-once')).toHaveCount(1)
    await firstApproval.getByTestId('approve-once').click()
    await command(profile.app, 'waitForIdle', { conversationId })

    await attachFixtureFiles(profile, ['sample.docx'])
    await submitChat(profile.page, '把 sample.docx 转成 PDF')

    const secondApproval = profile.page.getByTestId('approval-card').filter({ hasText: '目标格式：pdf' })
    await expect(secondApproval).toBeVisible()
    await expect(secondApproval).toContainText('附件 0：sample.docx')
    await expect(secondApproval).not.toContainText('附件 1')
    await expect(profile.page.getByTestId('approve-once')).toHaveCount(1)
    await secondApproval.getByTestId('approve-once').click()
    await command(profile.app, 'waitForIdle', { conversationId })

    const blocks = profile.page.getByLabel('文件转换结果')
    await expect(blocks).toHaveCount(2)
    await expect(blocks.filter({ hasText: 'ICO' })).toContainText('转换完成', { timeout: 60_000 })
    await expect(blocks.filter({ hasText: 'PDF' })).toContainText('转换完成', { timeout: 60_000 })
    await expect(blocks.filter({ hasText: 'ICO' })).toContainText(
      '图标规格: 16×16、24×24、32×32、48×48、64×64、128×128、256×256',
    )
    await expect(profile.page.getByTestId('approval-card')).toHaveCount(2)
    await expect(profile.page.getByTestId('approve-once')).toHaveCount(0)

    const icoCopy = join(artifactRoot, 'chat-favicon.ico')
    const pdfCopy = join(artifactRoot, 'chat-document.pdf')
    await rm(icoCopy, { force: true })
    await rm(pdfCopy, { force: true })
    await command(profile.app, 'setSavePaths', { paths: [icoCopy, pdfCopy] })
    await blocks.filter({ hasText: 'ICO' }).getByTestId('conversion-save-copy').click()
    await blocks.filter({ hasText: 'PDF' }).getByTestId('conversion-save-copy').click()
    await expect.poll(async () => (await command<HarnessSnapshot>(profile.app, 'snapshot')).saveDialogDefaults)
      .toHaveLength(2)
    expectIco(await readFile(icoCopy))
    expectPdf(await readFile(pdfCopy))
    await blocks.filter({ hasText: 'ICO' }).getByTestId('conversion-preview').click()
    await expect.poll(async () => (await command<HarnessSnapshot>(profile.app, 'snapshot')).previewedCount)
      .toBe(1)

    const snapshot = await command<HarnessSnapshot>(profile.app, 'snapshot')
    expect(snapshot.nativePickerNames).toEqual([
      ['transparent-nonsquare.png', 'sample.docx'],
      ['transparent-nonsquare.png', 'sample.docx'],
      ['sample.docx'],
    ])
    expect(snapshot.saveDialogDefaults).toEqual([
      'transparent-nonsquare.ico',
      'sample.pdf',
    ])
    expect(snapshot.processEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ pack: 'image-icon', targetFormat: 'ico', processExited: true }),
      expect.objectContaining({ pack: 'document', targetFormat: 'pdf', processExited: true }),
    ]))
    const providerPayload = snapshot.providerRequests.map(({ serialized }) => serialized).join('\n')
    expect(providerPayload).toContain('附件数量：1')
    expect(providerPayload).toContain('附件索引：0')
    expect(providerPayload).toContain('目标格式：ico')
    expect(providerPayload).toContain('目标格式：pdf')
    expect(providerPayload).not.toMatch(
      /transparent-nonsquare|sample\.docx|image\/png|application\/vnd\.openxmlformats/iu,
    )
    expect(providerPayload).not.toContain(profile.userData)
    expect(providerPayload).not.toContain(bundleRoot!)
    expect(providerPayload).not.toMatch(
      /(?:\\?")(?:assetId|mediaAssetId|sourceId|artifactId|jobId|executionId|sha256|sourceFingerprint|attachmentBindings|fileConvertAuthorization|dataBase64)(?:\\?")\s*:/i,
    )
    expect(providerPayload).not.toMatch(/iVBORw0|UEsDB|["']path["']\s*:/i)
    await screenshot(profile.page, 'chat-completed-wide')
  })

  test('discovers the development workflow, sends indexes plus opaque IDs, and cancellation beats a late WebM process result', async () => {
    const profile = await launchProfile()
    launchedProfiles.push(profile)

    await profile.page.getByRole('link', { name: '工作流', exact: true }).click()
    const workflowListProbe = await profile.page.evaluate(async () => {
      try {
        return { items: await window.autoForge.workflows.list({}) }
      } catch (error) {
        return {
          error: error instanceof Error
            ? { name: error.name, message: error.message, code: 'code' in error ? error.code : undefined }
            : String(error),
        }
      }
    })
    expect(workflowListProbe).toEqual({
      items: expect.arrayContaining([expect.objectContaining({ id: 'file.convert.universal', name: '万象转换' })]),
    })
    const workflow = profile.page.getByRole('button', { name: '查看万象转换详情' }).first()
    await expect(workflow).toBeVisible()
    await workflow.click()
    await expect(profile.page.getByText('file.convert.universal')).toBeVisible()

    await profile.page.getByRole('link', { name: '开发', exact: true }).click()
    await expect(profile.page.getByText('万象转换', { exact: true }).first()).toBeVisible()
    expect(await command<string>(profile.app, 'projectId')).not.toBe('')
    await command(profile.app, 'setPickerFiles', { names: ['sample.mp4'] })
    await profile.page.getByTestId('debug-pick-files-files').click()
    await expect(profile.page.getByText(/sample\.mp4/u)).toBeVisible()
    await profile.page.getByTestId('debug-field-targetFormat').selectOption({ label: '"webm" (string)' })
    await command(profile.app, 'armHold', { mode: 'late-cancel' })
    await profile.page.getByRole('button', { name: '运行', exact: true }).click()
    const heldJobId = await command<string>(profile.app, 'waitForHeld')

    const conversionBlock = profile.page.getByLabel('文件转换结果')
    await expect(conversionBlock).toContainText('正在转换')

    await profile.page.getByTestId('tree-entry-workflow.json').click()
    await replaceMonacoContent(profile.page, JSON.stringify({
      permissions: [],
      inputSchema: { type: 'object' },
    }))
    await expect(profile.page.locator('.permissions')).not.toContainText('file.convert')
    await expect(conversionBlock).toContainText('正在转换')

    await replaceMonacoContent(profile.page, '{ invalid')
    await expect(profile.page.getByText('workflow.json 不是有效 JSON，无法生成调试表单。')).toBeVisible()
    await expect(conversionBlock).toContainText('正在转换')
    await profile.page.getByTestId('tree-entry-src/index.ts').click()
    await expect(conversionBlock).toContainText('正在转换')
    await screenshot(profile.page, 'developer-conversion-snapshot-invalid-manifest')

    await conversionBlock.getByTestId('conversion-cancel').click()
    await expect(conversionBlock).toContainText('转换已取消')
    await command(profile.app, 'releaseHeld')
    await expect.poll(async () => (
      (await command<HarnessSnapshot>(profile.app, 'snapshot')).jobs.find(({ jobId }) => jobId === heldJobId)?.status
    )).toBe('cancelled')
    await expect(conversionBlock).not.toContainText('转换完成')

    const snapshot = await command<HarnessSnapshot>(profile.app, 'snapshot')
    expect(snapshot.processEvidence).toContainEqual(expect.objectContaining({
      jobId: heldJobId, pack: 'media', targetFormat: 'webm', processExited: true,
    }))
    expect(snapshot.developerRuns).toHaveLength(1)
    expect(snapshot.developerRuns[0]).toMatchObject({
      input: { files: [0], targetFormat: 'webm' },
      attachmentIds: [expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]+$/u)],
    })
    const rendererPayload = JSON.stringify(snapshot.developerRuns[0])
    expect(rendererPayload).not.toContain(join(bundleRoot!, 'fixtures', 'sample.mp4'))
    expect(rendererPayload).not.toContain('sample.mp4')
    expect(snapshot.nativePickerNames).toEqual([['sample.mp4']])
    await conversionBlock.scrollIntoViewIfNeeded()
    await screenshot(profile.page, 'developer-cancelled-wide')
    await screenshotElement(conversionBlock, 'developer-cancelled-wide-card')
    await command(profile.app, 'setTheme', { theme: 'dark' })
    expect(await command<string>(profile.app, 'theme')).toBe('dark')
    expect(await command(profile.app, 'themeState')).toEqual({
      themeSource: 'dark', shouldUseDarkColors: true,
    })
    await profile.page.emulateMedia({ colorScheme: 'dark' })
    expect(await profile.page.evaluate(() => (
      window.matchMedia('(prefers-color-scheme: dark)').matches
    ))).toBe(true)
    await screenshotElement(conversionBlock, 'developer-cancelled-dark-card')
    await command(profile.app, 'setWindowSize', { width: 1760, height: 900 })
    await command(profile.app, 'setZoom', { factor: 2 })
    const windowState = await command<{
      size: number[]
      contentSize: number[]
      zoomFactor: number
    }>(profile.app, 'windowState')
    expect(windowState.zoomFactor).toBe(2)
    expect(windowState.contentSize[0]).toBeGreaterThanOrEqual(1_600)
    await expect.poll(() => profile.page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(900)
    await command(profile.app, 'focusWindow')
    await profile.page.bringToFront()
    const inspectorToggle = profile.page.getByTestId('inspector-toggle')
    await expect(inspectorToggle).toHaveAttribute('aria-expanded', 'false')
    await inspectorToggle.click()
    await expect(inspectorToggle).toHaveAttribute('aria-expanded', 'true')
    const inspector = profile.page.getByTestId('inspector-panel')
    await expect(inspector).toBeVisible()
    await expect(inspector).toHaveAttribute('data-open', 'true')
    await conversionBlock.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest' }))
    const retryButton = conversionBlock.getByTestId('conversion-retry')
    await retryButton.evaluate((element) => { (element as HTMLElement).focus() })
    await profile.page.keyboard.press('Tab')
    await profile.page.keyboard.press('Shift+Tab')
    await expect(retryButton).toBeFocused()
    expect(await retryButton.evaluate((element) => element.matches(':focus-visible'))).toBe(true)
    await captureElectronPage(profile, 'developer-cancelled-dark-narrow-200-percent-focused')
  })

  test('recovers an in-flight conversion as interrupted after restart and retries to a verified completed artifact', async () => {
    const first = await launchProfile()
    launchedProfiles.push(first)
    const conversationId = await createConversation(first)
    await attachFixtureFiles(first, ['transparent-nonsquare.png'])
    await command(first.app, 'armHold', { mode: 'restart' })
    await submitChat(first.page, '把 transparent-nonsquare.png 转成 ico')
    const approval = first.page.getByTestId('approval-card').filter({ hasText: '目标格式：ico' })
    await expect(approval).toBeVisible()
    await approval.getByTestId('approve-once').click()
    const heldJobId = await command<string>(first.app, 'waitForHeld')
    await expect(first.page.getByLabel('文件转换结果')).toContainText('正在转换')
    await screenshot(first.page, 'restart-before-quit-converting')

    await first.app.close()
    const second = await launchProfile({ userData: first.userData })
    launchedProfiles.push(second)
    const persistedConversation = await command<string>(second.app, 'selectedConversation')
    expect(persistedConversation).toBe(conversationId)
    await second.page.locator('.conversation-select').first().click()
    const recovered = second.page.getByLabel('文件转换结果')
    await expect(recovered).toContainText('转换已中断', { timeout: 30_000 })
    await screenshot(second.page, 'restart-interrupted')
    await recovered.getByTestId('conversion-retry').click()
    await expect(recovered).toContainText('转换完成', { timeout: 60_000 })

    const restartCopy = join(artifactRoot, 'restart-favicon.ico')
    await rm(restartCopy, { force: true })
    await command(second.app, 'setSavePaths', { paths: [restartCopy] })
    await recovered.getByTestId('conversion-save-copy').click()
    await expect.poll(async () => (await command<HarnessSnapshot>(second.app, 'snapshot')).saveDialogDefaults)
      .toEqual(['transparent-nonsquare.ico'])
    expectIco(await readFile(restartCopy))
    const snapshot = await command<HarnessSnapshot>(second.app, 'snapshot')
    expect(snapshot.jobs.find(({ jobId }) => jobId === heldJobId)).toMatchObject({
      status: 'completed', epoch: 1,
      artifacts: [expect.objectContaining({ detectedFormat: 'ico', status: 'ready' })],
    })
    expect(snapshot.processEvidence).toContainEqual(expect.objectContaining({
      jobId: heldJobId, epoch: 1, pack: 'image-icon', processExited: true,
    }))
    await screenshot(second.page, 'restart-retried-completed')
  })

  test('renders download pending, long multi-output, deleted, and remote-only visual states', async () => {
    const profile = await launchProfile()
    launchedProfiles.push(profile)
    await profile.page.getByRole('link', { name: '开发', exact: true }).click()
    await command(profile.app, 'setPickerFiles', { names: ['sample.mp4'] })
    await profile.page.getByTestId('debug-pick-files-files').click()
    await profile.page.getByTestId('debug-field-targetFormat').selectOption({ label: '"webm" (string)' })
    await command(profile.app, 'armHold', { mode: 'download' })
    await profile.page.getByRole('button', { name: '运行', exact: true }).click()
    await command<string>(profile.app, 'waitForHeld')
    const downloadBlock = profile.page.getByLabel('文件转换结果')
    await expect(downloadBlock).toContainText('正在下载转换组件')
    await downloadBlock.scrollIntoViewIfNeeded()
    await screenshot(profile.page, 'visual-download-wide')
    await screenshotElement(downloadBlock, 'visual-download-wide-card')

    await downloadBlock.getByTestId('conversion-cancel').click()
    await expect(downloadBlock).toContainText('转换已取消')
    await expect(downloadBlock.getByTestId('conversion-retry')).toBeDisabled()
    await downloadBlock.scrollIntoViewIfNeeded()
    await screenshot(profile.page, 'visual-cancel-action-pending')
    await screenshotElement(downloadBlock, 'visual-cancel-action-pending-card')
    await command(profile.app, 'releaseHeld')
    await expect(downloadBlock.getByTestId('conversion-retry')).toBeEnabled()

    await command(profile.app, 'seedVisualConversations')
    await profile.page.reload()
    await expect(profile.page.getByLabel('主导航')).toBeVisible()
    await profile.page.getByRole('link', { name: '聊天', exact: true }).click()
    await profile.page.locator('.conversation-select').filter({ hasText: '视觉多产物' }).click()
    const multiOutput = profile.page.getByLabel('文件转换结果')
    await expect(multiOutput).toContainText('2 个本地转换任务')
    await expect(multiOutput).toContainText('第 1 页')
    await expect(multiOutput).toContainText('第 3 页')
    await expect(multiOutput).toContainText('icp4: 16×16 @1x (16×16)')
    await expect(multiOutput).toContainText('ic11: 16×16 @2x (32×32)')
    await expect(multiOutput).toContainText('2026-final-release-aaaaaaaaaaaaaaaaaaaa')
    await screenshot(profile.page, 'visual-long-name-multiple-pages-representations')
    const visualJobs = multiOutput.locator('.conversion-job')
    await expect(visualJobs).toHaveCount(2)
    await screenshotElement(visualJobs.nth(0), 'visual-multiple-pages-card')
    await screenshotElement(visualJobs.nth(1), 'visual-multiple-representations-card')

    await command(profile.app, 'setWindowSize', { width: 1_120, height: 720 })
    await command(profile.app, 'setZoom', { factor: 1 })
    expect(await profile.page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(1_120)
    await multiOutput.scrollIntoViewIfNeeded()
    expect(await multiOutput.locator('.conversion-artifact').evaluateAll((artifacts) => (
      artifacts.every((artifact) => artifact.scrollWidth <= artifact.clientWidth)
    ))).toBe(true)
    await screenshot(profile.page, 'visual-chat-narrow-long-multiple-output')
    await screenshotElement(multiOutput, 'visual-chat-narrow-long-multiple-output-card')

    const firstArtifact = multiOutput.locator('.conversion-artifact').first()
    await firstArtifact.getByTestId('conversion-delete').click()
    await expect(firstArtifact.getByText('已删除')).toBeVisible()
    await expect(firstArtifact.getByTestId('conversion-save-copy')).toBeDisabled()
    await expect(firstArtifact.getByTestId('conversion-preview')).toBeDisabled()
    await expect(firstArtifact.getByTestId('conversion-delete')).toBeDisabled()
    await screenshot(profile.page, 'visual-artifact-deleted')

    await profile.page.locator('.conversation-select').filter({ hasText: '远程转换结果' }).click()
    const remoteOnly = profile.page.getByLabel('文件转换结果')
    await expect(remoteOnly).toContainText('转换结果仅在发起转换的设备上可用')
    await screenshot(profile.page, 'visual-remote-only')
  })

  test('fails closed on an invalid signed pack root without falling back to PATH', async () => {
    const invalidRoot = await mkdtemp(join(artifactRoot, 'invalid-pack-root-'))
    const sentinelRoot = await mkdtemp(join(artifactRoot, 'path-sentinel-'))
    cleanupRoots.add(invalidRoot)
    cleanupRoots.add(sentinelRoot)
    await cp(bundleRoot!, invalidRoot, { recursive: true })
    await writeFile(join(invalidRoot, 'release/index.sig'), 'invalid-signature\n', 'utf8')
    const sentinelMarker = join(sentinelRoot, 'ffmpeg-was-invoked')
    const sentinelExecutable = join(sentinelRoot, 'ffmpeg')
    await writeFile(
      sentinelExecutable,
      '#!/bin/sh\n: > "${0%/*}/ffmpeg-was-invoked"\nexit 97\n',
      'utf8',
    )
    await chmod(sentinelExecutable, 0o755)

    const profile = await launchProfile({
      packRoot: invalidRoot,
      env: {
        PATH: sentinelRoot,
      },
    })
    launchedProfiles.push(profile)
    await profile.page.getByRole('link', { name: '开发', exact: true }).click()
    await command(profile.app, 'setPickerFiles', { names: ['sample.mp4'] })
    await profile.page.getByTestId('debug-pick-files-files').click()
    await profile.page.getByTestId('debug-field-targetFormat').selectOption({ label: '"webm" (string)' })
    await profile.page.getByRole('button', { name: '运行', exact: true }).click()

    const conversionBlock = profile.page.getByLabel('文件转换结果')
    await expect(conversionBlock).toContainText('转换失败', { timeout: 30_000 })
    const snapshot = await command<HarnessSnapshot>(profile.app, 'snapshot')
    expect(snapshot.jobs).toContainEqual(expect.objectContaining({
      targetFormat: 'webm', status: 'failed', errorCode: 'CONVERSION_COMPONENT_UNAVAILABLE', artifacts: [],
    }))
    expect(snapshot.processEvidence).toEqual([])
    await expect(access(sentinelMarker)).rejects.toMatchObject({ code: 'ENOENT' })
    await conversionBlock.scrollIntoViewIfNeeded()
    await screenshot(profile.page, 'invalid-pack-failed-no-path-fallback')
    await screenshotElement(conversionBlock, 'invalid-pack-failed-no-path-fallback-card')
  })
})
