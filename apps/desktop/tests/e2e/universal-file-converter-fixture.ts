import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  protocol,
  session,
  type Event,
} from 'electron'
import {
  chatEventSchema,
  executionEventSchema,
  ipcChannels,
  toSafeAppError,
  type AuthSession,
  type ConversionTargetFormat,
  type DesktopAPI,
} from '@autoforge/shared'
import { createApplicationRuntime } from '../../electron/main/application.js'
import type { AuthService } from '../../electron/main/auth/auth-service.js'
import type {
  ApplicationBrowserWorkspacePort,
  BrowserWorkspaceTab,
} from '../../electron/main/browser/electron-browser-workspace.js'
import type { CredentialBoundModelProvider } from '../../electron/main/chat/model-provider-registry.js'
import type {
  ModelStreamEvent,
  ModelStreamRequest,
} from '../../electron/main/chat/model-provider.js'
import { sanitizeDisplayName } from '../../electron/main/chat/local-conversion-intent.js'
import { openAppDatabase } from '../../electron/main/database/client.js'
import { UserDataStoreManager } from '../../electron/main/database/user-data-client.js'
import type { ConversionJob } from '../../electron/main/database/repositories.js'
import { createConversionArtifactService, type ResolvedOwnedInput } from '../../electron/main/conversion/conversion-artifact-service.js'
import type { ConversionJobRuntime } from '../../electron/main/conversion/conversion-job-runner.js'
import { imageIconAdapter } from '../../electron/main/conversion/adapters/image-icon.js'
import { documentAdapter } from '../../electron/main/conversion/adapters/document.js'
import { pdfAdapter } from '../../electron/main/conversion/adapters/pdf.js'
import { mediaAdapter } from '../../electron/main/conversion/adapters/media.js'
import {
  createConversionProcessRunner,
  createNodeConversionProcessTreePort,
  type ConversionProcessPlan,
  type ConverterAdapter,
} from '../../electron/main/conversion/conversion-process-runner.js'
import { ConverterPackManager } from '../../electron/main/conversion/converter-pack-manager.js'
import type {
  ConverterPackIndex,
  ConverterPackLease,
  ConverterPackName,
} from '../../electron/main/conversion/converter-pack-types.js'
import { registerDesktopIpc } from '../../electron/main/ipc/register-ipc.js'
import { createMediaProtocolHandler } from '../../electron/main/media/media-protocol.js'
import { resolveUserConversionRoot } from '../../electron/main/media/user-media-root.js'
import type { NetworkProxyPort } from '../../electron/main/network/network-proxy-service.js'
import { createSecureWindow } from '../../electron/main/window.js'
import { isAbsoluteConverterPackTestRoot } from '../integration/converter-pack-test-root.js'

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing E2E environment variable: ${name}`)
  return value
}

const desktopRoot = requiredEnvironment('AUTOFORGE_E2E_DESKTOP_ROOT')
const repositoryRoot = requiredEnvironment('AUTOFORGE_E2E_REPOSITORY_ROOT')
const userData = requiredEnvironment('AUTOFORGE_E2E_USER_DATA')
const bundleRoot = requiredEnvironment('AUTOFORGE_TEST_CONVERTER_PACK_ROOT')
if (!isAbsoluteConverterPackTestRoot(bundleRoot, process.platform)) {
  throw new Error('AUTOFORGE_TEST_CONVERTER_PACK_ROOT must be an absolute signed fixture root')
}
const fixtureRoot = join(bundleRoot, 'fixtures')
const databasePath = join(userData, 'autoforge.sqlite')
const userId = 'e2e_converter_user'

protocol.registerSchemesAsPrivileged([{
  scheme: 'autoforge-media',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}])
app.setPath('userData', userData)

function fixtureSession(): AuthSession {
  return {
    user: { id: userId, account: 'E2EConverter' },
    authenticatedAt: '2026-08-29T00:00:00.000Z',
    authorization: {
      role: 'user', capabilities: [], version: 1,
      updatedAt: '2026-08-29T00:00:00.000Z', confirmed: true,
    },
  }
}

function testAuthService(): AuthService {
  return {
    async getSession() { return fixtureSession() },
    async sendOtp() { return { challengeId: 'e2e_converter_challenge', expiresIn: 300 } },
    async verifyOtp() { return fixtureSession() },
    async cancelOtp() { /* deterministic no-op */ },
    async loginWithPassword() { return fixtureSession() },
    async updateUserProfile(input) {
      const current = fixtureSession().user
      return { ...current, profile: { ...current.profile, ...input } }
    },
    async discardSession() { /* fixed authenticated fixture */ },
    async logout() { /* fixed authenticated fixture */ },
    async requireSession() { return fixtureSession() },
  }
}

function createBrowserWorkspace(): ApplicationBrowserWorkspacePort {
  let currentUrl = 'https://fixture.invalid/'
  const tab: BrowserWorkspaceTab = {
    id: 'universal-converter-e2e-tab', navigationEpoch: 0,
    async open(url) { currentUrl = url },
    async fill() { /* unused */ },
    async click() { /* unused */ },
    async url() { return currentUrl },
    async currentOrigin() { return new URL(currentUrl).origin },
    async focus() { /* unused */ },
    async close() { /* unused */ },
  }
  return {
    setSessionStorageStore() { /* no browser state */ },
    async acquire() { return tab },
    async releaseExecution() { /* no browser execution */ },
    setContinuationRegistry() { /* no continuation */ },
    markContinuationBound() { /* no continuation */ },
    async updateProxy() { /* local-only fixture */ },
    async reset() { /* no browser state */ },
    async shutdown() { /* no browser state */ },
    async acquireContinuation() { /* no continuation */ },
    async releaseContinuation() { /* no continuation */ },
    async suspendContinuation() { /* no continuation */ },
    async resumeContinuation() { /* no continuation */ },
    onContinuationActivity() { return () => undefined },
    async closeContinuation() { /* no continuation */ },
    async getContinuationState() {
      return { origin: 'https://fixture.invalid', url: currentUrl, navigationEpoch: 0, activityRevision: 0 }
    },
    async focusContinuation() { /* no continuation */ },
    async highlightContinuationTarget() { /* no continuation */ },
    async clearContinuationHighlight() { /* no continuation */ },
    async performContinuationAction() { /* no continuation */ },
    async describeContinuation() { return undefined },
    async clearUserData() { /* profile is removed by Playwright */ },
    setContinuationCommandHandlers() { /* no continuation */ },
    async readAccessibilitySnapshot(input) {
      return {
        tabId: input.tabId, navigationEpoch: input.expectedNavigationEpoch,
        origin: input.expectedOrigin, url: input.expectedOrigin, title: 'Unused fixture page',
        frameId: 'frame_unused', viewportWidth: 1, viewportHeight: 1, nodes: [], locatorMatches: [],
      }
    },
    async readNode() { return undefined },
    async getNodeBox() { return { x: 0, y: 0, width: 1, height: 1, viewportWidth: 1, viewportHeight: 1 } },
    async captureNodeScreenshot() { return '' },
    async capturePageScreenshot() { return '' },
    onPageInvalidated() { return () => undefined },
  }
}

const networkProxy: NetworkProxyPort = {
  async initialize() { /* local-only */ },
  async transition() { /* local-only */ },
  async transitionOrFailClosed() { /* local-only */ },
  async snapshot() { return { enabled: false, bypassRules: '<local>' } },
  async withTransportLease(operation) {
    return operation({ settings: { enabled: false, bypassDomains: [] } })
  },
  async fetch() { throw toSafeAppError({ code: 'MODEL_PROVIDER_UNAVAILABLE' }) },
}

interface CapturedProviderRequest {
  serialized: string
  workflowToolName?: string
  workflowCalls: number
}

const providerRequests: CapturedProviderRequest[] = []

function currentUserText(request: ModelStreamRequest): string {
  const message = [...request.messages].reverse().find((candidate) => candidate.role === 'user')
  if (!message || message.role !== 'user') return ''
  if (typeof message.content === 'string') return message.content
  return message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
}

function currentTurnWorkflowCallCount(request: ModelStreamRequest, name: string): number {
  const lastUserIndex = request.messages.findLastIndex((message) => message.role === 'user')
  return request.messages.slice(lastUserIndex + 1).reduce((count, message) => (
    message.role === 'assistant'
      ? count + (message.tool_calls?.filter((call) => call.function.name === name).length ?? 0)
      : count
  ), 0)
}

function scriptedToolCall(name: string, input: unknown): ModelStreamEvent {
  return {
    type: 'tool_call', choiceIndex: 0, index: 0,
    id: `e2e_convert_${randomUUID()}`, name, arguments: { input },
  }
}

const deterministicProvider: CredentialBoundModelProvider = {
  async listModels() {
    return [{
      id: 'openrouter/e2e-converter', name: 'E2E Converter',
      inputModalities: ['text' as const, 'image' as const], outputModalities: ['text' as const],
      supportsTools: true, generation: {}, contextLength: 128_000,
    }]
  },
  async validateCredential() { return { valid: true } },
  async *stream(request: ModelStreamRequest) {
    const workflowTool = request.tools?.find((tool) => tool.function.description.includes('file.convert.universal@1.0.0'))
    const calls = workflowTool ? currentTurnWorkflowCallCount(request, workflowTool.function.name) : 0
    providerRequests.push({
      serialized: JSON.stringify({ messages: request.messages, tools: request.tools }),
      ...(workflowTool === undefined ? {} : { workflowToolName: workflowTool.function.name }),
      workflowCalls: calls,
    })
    if (!workflowTool) {
      yield { type: 'text_delta', choiceIndex: 0, text: '万象转换' }
      yield { type: 'finish', choiceIndex: 0, reason: 'stop' }
      return
    }
    const userText = currentUserText(request)
    const targetFormat = /\bico\b/iu.test(userText)
      ? 'ico'
      : /\bpdf\b/iu.test(userText)
        ? 'pdf'
        : undefined
    if (targetFormat === 'ico' && calls === 0) {
      yield scriptedToolCall(workflowTool.function.name, { files: [0], targetFormat: 'ico' })
      yield { type: 'finish', choiceIndex: 0, reason: 'tool_calls' }
      return
    }
    if (targetFormat === 'pdf' && calls === 0) {
      yield scriptedToolCall(workflowTool.function.name, { files: [0], targetFormat: 'pdf' })
      yield { type: 'finish', choiceIndex: 0, reason: 'tool_calls' }
      return
    }
    yield { type: 'text_delta', choiceIndex: 0, text: '本地转换已提交。' }
    yield { type: 'finish', choiceIndex: 0, reason: 'stop' }
  },
  async acquireSnapshot() {
    return { providerId: 'openrouter', provider: deterministicProvider, apiKeyFingerprint: 'e2e-converter-fingerprint' }
  },
}

type AdapterEntry = { adapter: ConverterAdapter; pack: ConverterPackName }
const adapters: readonly AdapterEntry[] = [
  { adapter: imageIconAdapter, pack: 'image-icon' },
  { adapter: documentAdapter, pack: 'document' },
  { adapter: pdfAdapter, pack: 'pdf' },
  { adapter: mediaAdapter, pack: 'media' },
]

type HoldMode = 'none' | 'download' | 'late-cancel' | 'restart'
type HeldConversion = { mode: Exclude<HoldMode, 'none'>; release(): void; promise: Promise<void> }
let nextHoldMode: HoldMode = 'none'
const heldConversions = new Map<string, HeldConversion>()
const processEvidence: Array<{
  jobId: string
  epoch: number
  pack: ConverterPackName
  targetFormat: ConversionTargetFormat
  processExited: true
}> = []

function newHold(mode: Exclude<HoldMode, 'none'>): HeldConversion {
  let release!: () => void
  const promise = new Promise<void>((resolvePromise) => { release = resolvePromise })
  return { mode, release, promise }
}

function outputDisplayName(sourceName: string, targetFormat: ConversionTargetFormat): string {
  const safe = sanitizeDisplayName(sourceName)
  const extension = extname(safe)
  const sourceBase = basename(safe, extension) || 'converted'
  const targetExtension = `.${targetFormat}`
  const maximumBaseLength = Math.max(1, 255 - targetExtension.length)
  return `${[...sourceBase].slice(0, maximumBaseLength).join('')}${targetExtension}`
}

function outputBatchDisplayName(
  sourceName: string,
  targetFormat: ConversionTargetFormat,
  plan: ConversionProcessPlan,
  index: number,
): string {
  const safe = sanitizeDisplayName(sourceName)
  const extension = extname(safe)
  const sourceBase = basename(safe, extension) || 'converted'
  if (plan.outputContract.kind === 'pdf-pages') {
    return `${sourceBase}-page-${String(index + 1).padStart(3, '0')}.${targetFormat}`
  }
  const representation = plan.outputs[index]?.metadata?.iconRepresentation
  if (representation) {
    return `${sourceBase}-${representation.logicalWidth}x${representation.logicalHeight}@${representation.scale}x.${targetFormat}`
  }
  if (plan.outputContract.kind === 'icon-representations') {
    return `${sourceBase}-representation-${String(index + 1).padStart(3, '0')}.${targetFormat}`
  }
  return outputDisplayName(sourceName, targetFormat)
}

function createSignedConversionRuntime(
  database: ReturnType<typeof openAppDatabase>,
  userDataStores: UserDataStoreManager,
): ConversionJobRuntime {
  const releaseRoot = join(bundleRoot, 'release')
  const signedIndex = {
    index: JSON.parse(readFileSync(join(releaseRoot, 'index.json'), 'utf8')) as ConverterPackIndex,
    signature: readFileSync(join(releaseRoot, 'index.sig'), 'utf8').trim(),
  }
  const manager = new ConverterPackManager({
    packsRoot: join(bundleRoot, 'installed'),
    rootPublicKeyPem: readFileSync(join(bundleRoot, 'test-root-public-key.pem'), 'utf8'),
    platform: process.platform,
    arch: process.arch,
  })
  const processRunner = createConversionProcessRunner({ processTree: createNodeConversionProcessTreePort() })
  const artifacts = createConversionArtifactService({
    dataRoot: userData,
    database: {
      conversations: { get: (id) => userDataStores.current()?.conversations.get(id) },
      mediaAssets: { get: (id) => userDataStores.current()?.mediaAssets.get(id) },
      conversionArtifacts: database.conversionArtifacts,
      conversionJobs: database.conversionJobs,
    },
  })
  let initialized: Promise<void> | undefined
  const initialize = () => (initialized ??= manager.initialize())

  const resolveJobInput = async (job: ConversionJob): Promise<{ input: ResolvedOwnedInput; displayName: string }> => {
    if (job.ownerUserId !== userId) throw toSafeAppError({ code: 'CONVERSION_INPUT_INVALID' })
    if (job.sourceKind === 'media') {
      const store = userDataStores.current()
      const record = store?.mediaAssets.get(job.sourceId)
      const conversation = record ? store?.conversations.get(record.conversationId) : undefined
      if (!record || conversation?.userId !== userId || !record.mimeType || record.byteSize === undefined) {
        throw toSafeAppError({ code: 'CONVERSION_INPUT_INVALID' })
      }
      return {
        displayName: record.originalName,
        input: await artifacts.resolveOwnedInput({
          attachmentIndex: 0, ownerUserId: userId,
          displayName: record.originalName, mimeType: record.mimeType, byteSize: record.byteSize,
          source: { kind: 'media', mediaAssetId: record.id },
        }),
      }
    }
    const record = database.conversionArtifacts.getOwned(job.sourceId, userId)
    if (!record || record.role !== 'input' || record.status !== 'ready') {
      throw toSafeAppError({ code: 'CONVERSION_INPUT_INVALID' })
    }
    return {
      displayName: record.displayName,
      input: await artifacts.resolveOwnedInput({
        attachmentIndex: 0, ownerUserId: userId,
        displayName: record.displayName, mimeType: record.mimeType, byteSize: record.byteSize,
        source: { kind: 'artifact', artifactId: record.id },
      }),
    }
  }

  return {
    concurrencyClass(job) {
      if (['pdf', 'xlsx'].includes(job.targetFormat)) return 'document'
      if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'webm', 'mov'].includes(job.targetFormat)) return 'video'
      return 'other'
    },
    async acquirePack(job, signal): Promise<ConverterPackLease> {
      await initialize()
      if (signal.aborted) throw toSafeAppError({ code: 'CONVERSION_CANCELLED' })
      const source = await resolveJobInput(job)
      const selected = adapters.find(({ adapter }) => adapter.supports(source.input.probe, job.targetFormat))
      if (!selected) {
        await source.input.close()
        throw toSafeAppError({ code: 'CONVERSION_FORMAT_UNSUPPORTED' })
      }
      try {
        if (nextHoldMode === 'download') {
          nextHoldMode = 'none'
          const held = newHold('download')
          heldConversions.set(job.id, held)
          try { await held.promise } finally { heldConversions.delete(job.id) }
          if (signal.aborted) throw toSafeAppError({ code: 'CONVERSION_CANCELLED' })
        }
        return await manager.acquire({ signedIndex, name: selected.pack })
      } finally {
        await source.input.close().catch(() => undefined)
      }
    },
    async prepare(job, lease) {
      const context = await resolveJobInput(job)
      const selected = adapters.find(({ adapter }) => adapter.supports(context.input.probe, job.targetFormat))
      if (!selected || selected.pack !== lease.name) {
        await context.input.close()
        throw toSafeAppError({ code: 'CONVERSION_INTERRUPTED' })
      }
      let workRoot: string | undefined
      try {
        await mkdir(join(userData, 'temporary'), { recursive: true, mode: 0o700 })
        workRoot = await realpath(await mkdtemp(join(userData, 'temporary', 'converter-e2e-')))
        const plan = selected.adapter.plan(context.input.probe, {
          inputPath: context.input.mainPath,
          targetFormat: job.targetFormat,
          ...(job.preset === undefined ? {} : { preset: job.preset }),
        }, lease, workRoot)
        const batch = await artifacts.createOutputBatch(plan.outputs.map((_, index) => ({
          ownerUserId: job.ownerUserId,
          executionId: job.executionId,
          conversionJobId: job.id,
          displayName: outputBatchDisplayName(context.displayName, job.targetFormat, plan, index),
          targetFormat: job.targetFormat,
        })))
        let cleaned = false
        const cleanup = async () => {
          if (cleaned) return
          cleaned = true
          await context.input.close().catch(() => undefined)
          if (workRoot) await rm(workRoot, { recursive: true, force: true })
        }
        return {
          atomicJobCompletion: true as const,
          async execute(options) {
            options.onProgress(35)
            await processRunner.run(plan, lease, { signal: options.signal })
            processEvidence.push({
              jobId: job.id,
              epoch: job.epoch,
              pack: lease.name,
              targetFormat: job.targetFormat,
              processExited: true,
            })
            await Promise.all(plan.outputs.map((output, index) => copyFile(output.path, batch.outputs[index]!.tempPath)))
            options.onProgress(90)

            const mode = nextHoldMode
            nextHoldMode = 'none'
            if (mode !== 'none') {
              const held = newHold(mode)
              heldConversions.set(job.id, held)
              if (mode === 'restart') {
                const releaseOnAbort = () => held.release()
                options.signal.addEventListener('abort', releaseOnAbort, { once: true })
                try { await held.promise } finally { options.signal.removeEventListener('abort', releaseOnAbort) }
              } else {
                await held.promise
              }
              heldConversions.delete(job.id)
            }
          },
          async commit({ endedAt }) {
            try {
              return await batch.commit(plan.outputs.map((output) => (
                output.metadata === undefined ? {} : { metadata: output.metadata }
              )), {
                jobId: job.id,
                ownerUserId: job.ownerUserId,
                executionId: job.executionId,
                expectedEpoch: job.epoch,
                endedAt,
              })
            } finally {
              await cleanup()
            }
          },
          async abort() {
            await batch.abort()
            await cleanup()
          },
        }
      } catch (error) {
        await context.input.close().catch(() => undefined)
        if (workRoot) await rm(workRoot, { recursive: true, force: true })
        throw error
      }
    },
  }
}

let mainWindow: BrowserWindow | null = null
let runtime: ReturnType<typeof createApplicationRuntime> | undefined
let externalDatabase: ReturnType<typeof openAppDatabase> | undefined
let userDataStores: UserDataStoreManager | undefined
let disposeIpc: (() => void) | undefined
let agentState: { hasActiveRuns(): boolean } | undefined
let projectId = ''
const pickerQueue: string[][] = []
const savePathQueue: string[] = []
const nativePickerResults: string[][] = []
const saveDialogDefaults: string[] = []
const developerRuns: unknown[] = []
const revealedPaths: string[] = []

function emit(channel: string, value: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
  mainWindow.webContents.send(channel, value)
}

function fixturePath(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(name)) throw new Error(`Invalid fixture name: ${name}`)
  return join(fixtureRoot, name)
}

async function allJobViews(): Promise<Array<Awaited<ReturnType<DesktopAPI['conversion']['listForExecution']>>['jobs'][number]>> {
  if (!runtime || !externalDatabase) return []
  const results = []
  for (const execution of externalDatabase.executions.listForUser(userId)) {
    const view = await runtime.services.conversion.listForExecution({ executionId: execution.id })
    results.push(...view.jobs)
  }
  return results
}

async function seedVisualConversations(): Promise<{
  multiOutputConversationId: string
  remoteConversationId: string
}> {
  if (!externalDatabase || !userDataStores) throw new Error('Visual fixture storage is unavailable')
  const store = userDataStores.current()
  if (!store) throw new Error('Visual fixture user store is unavailable')
  const createdAt = Date.now()
  const executionId = randomUUID()
  const pagesJobId = randomUUID()
  const representationsJobId = randomUUID()
  externalDatabase.executions.insert({
    id: executionId,
    ownerUserId: userId,
    workflowId: 'file.convert.universal',
    workflowVersion: '1.0.0',
    status: 'completed',
    input: { files: [0], targetFormat: 'png' },
    result: { accepted: true },
    createdAt,
    startedAt: createdAt,
    endedAt: createdAt,
  })
  for (const [jobId, sourceId] of [
    [pagesJobId, randomUUID()],
    [representationsJobId, randomUUID()],
  ] as const) {
    externalDatabase.conversionJobs.create({
      id: jobId,
      ownerUserId: userId,
      executionId,
      sourceKind: 'artifact',
      sourceId,
      targetFormat: 'png',
      status: 'completed',
      epoch: 0,
      progress: 100,
      createdAt,
      updatedAt: createdAt,
      startedAt: createdAt,
      endedAt: createdAt,
    })
  }
  const bytes = await readFile(join(fixtureRoot, 'transparent-nonsquare.png'))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const resultsRoot = join(resolveUserConversionRoot(userData, userId), 'results')
  await mkdir(resultsRoot, { recursive: true, mode: 0o700 })
  const longBase = `2026-final-release-${'a'.repeat(210)}`
  const pageMetadata = [1, 2, 3].map((pdfPage) => ({ pdfPage }))
  const representationMetadata = [
    { iconRepresentation: { sourceType: 'icp4' as const, logicalWidth: 16 as const, logicalHeight: 16 as const, pixelWidth: 16 as const, pixelHeight: 16 as const, scale: 1 as const } },
    { iconRepresentation: { sourceType: 'ic11' as const, logicalWidth: 16 as const, logicalHeight: 16 as const, pixelWidth: 32 as const, pixelHeight: 32 as const, scale: 2 as const } },
    { iconRepresentation: { sourceType: 'icp5' as const, logicalWidth: 32 as const, logicalHeight: 32 as const, pixelWidth: 32 as const, pixelHeight: 32 as const, scale: 1 as const } },
  ]
  for (const [index, metadata] of [...pageMetadata, ...representationMetadata].entries()) {
    const artifactId = randomUUID()
    const relativePath = `results/${artifactId}.png`
    await copyFile(join(fixtureRoot, 'transparent-nonsquare.png'), join(resultsRoot, `${artifactId}.png`))
    const page = 'pdfPage' in metadata ? metadata.pdfPage : undefined
    externalDatabase.conversionArtifacts.create({
      id: artifactId,
      ownerUserId: userId,
      executionId,
      conversionJobId: page === undefined ? representationsJobId : pagesJobId,
      role: 'output',
      displayName: page === undefined
        ? `${longBase}-图标表示-${index - pageMetadata.length + 1}.png`
        : `${longBase}-第-${page}-页.png`,
      detectedFormat: 'png',
      mimeType: 'image/png',
      byteSize: bytes.byteLength,
      sha256,
      relativePath,
      metadata,
      status: 'ready',
      createdAt: createdAt + index,
      updatedAt: createdAt + index,
    })
  }

  const multiOutputConversationId = randomUUID()
  store.conversations.insert({
    id: multiOutputConversationId,
    title: '视觉多产物',
    userId,
    createdAt: createdAt + 10,
    updatedAt: createdAt + 10,
  })
  store.messages.insert({
    id: randomUUID(),
    conversationId: multiOutputConversationId,
    role: 'assistant',
    blocks: [{ type: 'conversion', blockId: randomUUID(), executionId, state: 'terminal' }],
    executionId,
    createdAt: createdAt + 10,
  })

  const remoteConversationId = randomUUID()
  store.conversations.insert({
    id: remoteConversationId,
    title: '远程转换结果',
    userId,
    createdAt: createdAt + 20,
    updatedAt: createdAt + 20,
  })
  store.messages.insert({
    id: randomUUID(),
    conversationId: remoteConversationId,
    role: 'assistant',
    blocks: [{
      type: 'conversion',
      blockId: randomUUID(),
      executionId: randomUUID(),
      state: 'terminal',
    }],
    createdAt: createdAt + 20,
  })
  return { multiOutputConversationId, remoteConversationId }
}

async function installUniversalWorkflow(): Promise<void> {
  if (!runtime) throw new Error('Application runtime is unavailable')
  const projects = await runtime.services.developer.listProjects()
  let project = projects.find((candidate) => candidate.name === '万象转换')
  if (!project) {
    project = await runtime.services.developer.createProject('万象转换')
    const [manifest, source] = await Promise.all([
      readFile(join(repositoryRoot, 'examples/universal-file-converter/workflow.json'), 'utf8'),
      readFile(join(repositoryRoot, 'examples/universal-file-converter/src/index.ts'), 'utf8'),
    ])
    await runtime.services.developer.writeFile(project.id, 'workflow.json', manifest)
    await runtime.services.developer.writeFile(project.id, 'src/index.ts', source)
    project = await runtime.services.developer.build(project.id)
  }
  projectId = project.id
  const installed = externalDatabase?.installedWorkflows.get('file.convert.universal', '1.0.0')
  if (!installed) {
    await runtime.services.workflows.installProject(project.id)
  }
}

async function dispatch(name: string, input: Record<string, unknown>): Promise<unknown> {
  if (!runtime) throw new Error('Universal converter E2E runtime is unavailable')
  if (name === 'selectedConversation') {
    return (await runtime.services.chat.listConversations({ limit: 50 })).items[0]?.id ?? ''
  }
  if (name === 'waitForIdle') {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (!agentState?.hasActiveRuns()) return true
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
    }
    throw new Error('Conversation did not become idle')
  }
  if (name === 'setPickerFiles') {
    const names = Array.isArray(input.names) ? input.names.map(String) : []
    pickerQueue.push(names.map(fixturePath))
    return true
  }
  if (name === 'setSavePaths') {
    const paths = Array.isArray(input.paths) ? input.paths.map(String) : []
    savePathQueue.push(...paths.map((path) => resolve(path)))
    return true
  }
  if (name === 'armHold') {
    const mode = String(input.mode)
    if (mode !== 'download' && mode !== 'late-cancel' && mode !== 'restart') {
      throw new Error(`Unsupported hold mode: ${mode}`)
    }
    nextHoldMode = mode
    return true
  }
  if (name === 'waitForHeld') {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (heldConversions.size > 0) return [...heldConversions.keys()][0]
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
    }
    throw new Error('No conversion reached the post-process hold')
  }
  if (name === 'releaseHeld') {
    for (const held of heldConversions.values()) held.release()
    return true
  }
  if (name === 'jobs') return allJobViews()
  if (name === 'seedVisualConversations') return seedVisualConversations()
  if (name === 'projectId') return projectId
  if (name === 'snapshot') {
    return {
      providerRequests: structuredClone(providerRequests),
      developerRuns: structuredClone(developerRuns),
      nativePickerNames: nativePickerResults.map((paths) => paths.map((path) => basename(path))),
      saveDialogDefaults: [...saveDialogDefaults],
      revealedCount: revealedPaths.length,
      heldJobIds: [...heldConversions.keys()],
      processEvidence: structuredClone(processEvidence),
      jobs: await allJobViews(),
    }
  }
  if (name === 'setTheme') {
    const theme = String(input.theme)
    if (theme !== 'light' && theme !== 'dark' && theme !== 'system') throw new Error('Invalid fixture theme')
    await runtime.services.settings.update({ theme })
    return true
  }
  if (name === 'theme') return (await runtime.services.settings.get()).theme
  if (name === 'themeState') {
    return { themeSource: nativeTheme.themeSource, shouldUseDarkColors: nativeTheme.shouldUseDarkColors }
  }
  if (name === 'setZoom') {
    mainWindow?.webContents.setZoomFactor(Number(input.factor))
    return true
  }
  if (name === 'setWindowSize') {
    mainWindow?.setSize(Number(input.width), Number(input.height))
    return true
  }
  if (name === 'capturePage') {
    if (!mainWindow) throw new Error('Main window is unavailable')
    return (await mainWindow.webContents.capturePage()).toPNG().toString('base64')
  }
  if (name === 'windowState') {
    return {
      size: mainWindow?.getSize() ?? [],
      contentSize: mainWindow?.getContentSize() ?? [],
      zoomFactor: mainWindow?.webContents.getZoomFactor() ?? 0,
    }
  }
  if (name === 'focusWindow') {
    mainWindow?.focus()
    return true
  }
  throw new Error(`Unknown universal converter E2E command: ${name}`)
}

async function initialize(): Promise<void> {
  await mkdir(userData, { recursive: true })
  userDataStores = new UserDataStoreManager(join(userData, 'user-caches'))
  externalDatabase = openAppDatabase(databasePath)
  const conversionRuntime = createSignedConversionRuntime(externalDatabase, userDataStores)
  runtime = createApplicationRuntime({
    paths: {
      database: databasePath,
      data: userData,
      logs: join(userData, 'logs'),
      projects: join(userData, 'workflow-projects'),
      installations: join(userData, 'installed-workflows'),
      workflowRunner: join(desktopRoot, 'out/workers/workflow-runner.cjs'),
      temporary: join(userData, 'temporary'),
    },
    safeStorage: {
      isAvailable: async () => true,
      encrypt: async (value) => Buffer.from(value, 'utf8'),
      decrypt: async (value) => ({ value: value.toString('utf8'), shouldReEncrypt: false }),
    },
    authService: testAuthService(),
    userDataStores,
    networkProxy,
    browserWorkspace: createBrowserWorkspace(),
    modelProviders: { openrouter: deterministicProvider },
    chooseProjectDirectory: async () => undefined,
    chooseMediaFiles: async (remainingSlots) => {
      const selected = (pickerQueue.shift() ?? []).slice(0, remainingSlots)
      nativePickerResults.push([...selected])
      return selected
    },
    chooseAvatarFile: async () => undefined,
    readClipboardImage: () => undefined,
    chooseMediaSavePath: async (defaultName) => {
      saveDialogDefaults.push(defaultName)
      return savePathQueue.shift()
    },
    revealPath: (path) => { revealedPaths.push(path) },
    openExternal: async () => undefined,
    emitChat: (event) => {
      const parsed = chatEventSchema.safeParse(event)
      if (parsed.success) emit(ipcChannels.chatEvent, parsed.data)
    },
    emitExecution: (event) => {
      const parsed = executionEventSchema.safeParse(event)
      if (parsed.success) emit(ipcChannels.executionsEvent, parsed.data)
    },
    applyTheme: (theme) => { nativeTheme.themeSource = theme },
    inspectAgent: (agent) => { agentState = agent },
    conversionRuntime,
    appInfo: { version: '0.1.0-e2e', platform: process.platform === 'win32' ? 'win32' : 'darwin' },
  })
  await runtime.recover()
  await runtime.services.settings.saveProviderApiKey('openrouter', 'e2e-only-key')
  const settings = await runtime.services.settings.get()
  await runtime.services.settings.update({
    activeProvider: 'openrouter',
    defaultModels: { ...settings.defaultModels, openrouter: { text: 'openrouter/e2e-converter' } },
    developerMode: true,
  })
  await installUniversalWorkflow()
  await protocol.handle('autoforge-media', createMediaProtocolHandler(runtime.mediaAssets))

  const rendererTarget = { kind: 'production' as const, filePath: join(desktopRoot, 'out/renderer/index.html') }
  const created = await createSecureWindow({
    BrowserWindow,
    session: session.defaultSession,
    preloadPath: join(desktopRoot, 'out/preload/index.cjs'),
    rendererTarget,
    backgroundColor: '#f3f5f8',
    getMainWindow: () => mainWindow,
    beforeLoad: (window) => {
      mainWindow = window as BrowserWindow
      const services = {
        ...runtime!.services,
        developer: {
          ...runtime!.services.developer,
          run: async (request: Parameters<DesktopAPI['developer']['run']>[0]) => {
            developerRuns.push(structuredClone(request))
            return runtime!.services.developer.run(request)
          },
        },
      }
      disposeIpc = registerDesktopIpc({
        ipcMain, services, getMainWindow: () => mainWindow, rendererTarget,
      })
    },
  })
  mainWindow = created as BrowserWindow
  mainWindow.on('closed', () => { mainWindow = null })
  ;(globalThis as typeof globalThis & {
    __AUTOFORGE_UNIVERSAL_CONVERTER_E2E__?: { dispatch: typeof dispatch }
  }).__AUTOFORGE_UNIVERSAL_CONVERTER_E2E__ = { dispatch }
}

let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  disposeIpc?.()
  disposeIpc = undefined
  for (const held of heldConversions.values()) {
    if (held.mode !== 'restart') held.release()
  }
  const current = runtime
  runtime = undefined
  if (current) await current.close()
  for (const held of heldConversions.values()) held.release()
  heldConversions.clear()
  externalDatabase?.close()
  externalDatabase = undefined
  userDataStores = undefined
}

void app.whenReady().then(initialize).catch((error) => {
  console.error(error)
  app.exit(1)
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', (event: Event) => {
  if (shuttingDown) return
  event.preventDefault()
  void shutdown().finally(() => app.quit())
})
