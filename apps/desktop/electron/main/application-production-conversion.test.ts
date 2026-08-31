import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuthSession } from '@autoforge/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthService } from './auth/auth-service.js'
import { createApplicationRuntime, type ApplicationRuntimeOptions } from './application.js'
import { createProductionConversionRuntimeFactory } from './conversion/production-conversion-runtime.js'
import { openAppDatabase } from './database/client.js'
import { resolveUserConversionRoot } from './media/user-media-root.js'
import { isAbsoluteConverterPackTestRoot } from '../../tests/integration/converter-pack-test-root.js'

const externalGate = 'EXTERNAL GATE: set AUTOFORGE_TEST_CONVERTER_PACK_ROOT to an absolute signed Task 13 fixture bundle.'
const bundleRoot = process.env.AUTOFORGE_TEST_CONVERTER_PACK_ROOT
const enabled = typeof bundleRoot === 'string'
  && isAbsoluteConverterPackTestRoot(bundleRoot, process.platform)
  && process.platform === 'darwin'
const roots: string[] = []

if (!enabled) console.warn(externalGate)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function authenticatedService(session: AuthSession): AuthService {
  let current: AuthSession | null = session
  const required = async () => {
    if (!current) throw new Error('No authenticated test session')
    return current
  }
  return {
    getSession: async () => current,
    sendOtp: async () => { throw new Error('Unexpected OTP request') },
    verifyOtp: required,
    cancelOtp: async () => undefined,
    loginWithPassword: required,
    updateUserProfile: async (input) => {
      const active = await required()
      current = { ...active, user: { ...active.user, profile: { ...active.user.profile, ...input } } }
      return current.user
    },
    discardSession: async () => { current = null },
    logout: async () => { current = null },
    requireSession: required,
  }
}

function browserWorkspace(): ApplicationRuntimeOptions['browserWorkspace'] {
  return {
    acquire: async () => { throw new Error('Unexpected browser acquisition') },
    releaseExecution: async () => undefined,
    updateProxy: async () => undefined,
    reset: async () => undefined,
    shutdown: async () => undefined,
    acquireContinuation: async () => undefined,
    releaseContinuation: async () => undefined,
    suspendContinuation: async () => undefined,
    resumeContinuation: async () => undefined,
    onContinuationActivity: () => () => undefined,
    closeContinuation: async () => undefined,
    getContinuationState: async () => { throw new Error('Unexpected continuation read') },
    focusContinuation: async () => undefined,
    highlightContinuationTarget: async () => undefined,
    clearContinuationHighlight: async () => undefined,
    performContinuationAction: async () => undefined,
    describeContinuation: async () => undefined,
    clearUserData: async () => undefined,
    setContinuationCommandHandlers: () => undefined,
    readAccessibilitySnapshot: async () => { throw new Error('Unexpected accessibility read') },
    readNode: async () => undefined,
    getNodeBox: async () => { throw new Error('Unexpected node box read') },
    captureNodeScreenshot: async () => { throw new Error('Unexpected screenshot') },
    capturePageScreenshot: async () => { throw new Error('Unexpected screenshot') },
    onPageInvalidated: () => () => undefined,
  }
}

describe.skipIf(!enabled)(`Application production conversion composition (${enabled ? 'enabled' : externalGate})`, () => {
  it('binds the ordinary factory and completes a signed three-page PDF without direct runtime injection', async () => {
    if (!bundleRoot) throw new Error(externalGate)
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-production-conversion-'))
    roots.push(root)
    const resourcesRoot = join(root, 'packaged-converter-resources')
    const releaseRoot = join(bundleRoot, 'release')
    await mkdir(resourcesRoot)
    await writeFile(join(resourcesRoot, 'bootstrap.json'), JSON.stringify({
      schemaVersion: 1,
      downloadsEnabled: true,
      indexUrl: 'https://packs.example.test/release/index.json',
      rootPublicKeyFile: 'root-public-key.pem',
      requiredPackFamilies: ['image-icon', 'document', 'pdf', 'media'],
      supportedTargets: ['darwin-arm64', 'darwin-x64'],
    }))
    await cp(join(bundleRoot, 'test-root-public-key.pem'), join(resourcesRoot, 'root-public-key.pem'))
    await cp(join(bundleRoot, 'installed'), join(root, 'converter-packs'), { recursive: true })

    const ownerUserId = 'production_factory_user'
    const executionId = 'production_factory_execution'
    const jobId = 'production_factory_job'
    const sourceId = 'production_factory_input'
    const sourceBytes = await readFile(join(bundleRoot, 'fixtures', 'three-page.pdf'))
    const ownerRoot = resolveUserConversionRoot(root, ownerUserId)
    const relativePath = 'inputs/production-factory-three-page.pdf'
    await mkdir(join(ownerRoot, 'inputs'), { recursive: true })
    await writeFile(join(ownerRoot, relativePath), sourceBytes)
    const database = openAppDatabase(join(root, 'autoforge.sqlite'))
    database.executions.insert({
      id: executionId,
      ownerUserId,
      workflowId: 'file.convert.universal',
      workflowVersion: '1.0.0',
      status: 'completed',
      input: {},
    })
    database.conversionArtifacts.create({
      id: sourceId,
      ownerUserId,
      executionId,
      role: 'input',
      displayName: 'three-page.pdf',
      detectedFormat: 'pdf',
      mimeType: 'application/pdf',
      byteSize: sourceBytes.byteLength,
      sha256: createHash('sha256').update(sourceBytes).digest('hex'),
      relativePath,
    })
    database.conversionJobs.create({
      id: jobId,
      ownerUserId,
      executionId,
      sourceKind: 'artifact',
      sourceId,
      targetFormat: 'png',
      status: 'queued',
    })
    database.close()

    const indexBytes = await readFile(join(releaseRoot, 'index.json'))
    const signatureBytes = await readFile(join(releaseRoot, 'index.sig'))
    const fetch = vi.fn(async (url: string) => {
      const bytes = url.endsWith('/index.json') ? indexBytes : signatureBytes
      return new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) },
      })
    })
    const withTransportLease = vi.fn(async (operation: () => Promise<unknown>) => operation())
    const networkProxy = {
      initialize: vi.fn(async () => undefined),
      transition: vi.fn(async () => undefined),
      transitionOrFailClosed: vi.fn(async () => undefined),
      snapshot: vi.fn(async () => ({ enabled: false, bypassRules: '<local>', playwrightArgs: [] })),
      fetch,
      withTransportLease,
    } as unknown as ApplicationRuntimeOptions['networkProxy']
    const createFactory = createProductionConversionRuntimeFactory({
      resourcesRoot,
      network: networkProxy,
      platform: process.platform,
      arch: process.arch,
    })
    const conversionRuntimeFactory = vi.fn(createFactory)
    const session: AuthSession = {
      user: { id: ownerUserId, account: 'production-factory' },
      authenticatedAt: new Date(0).toISOString(),
    }
    const runtime = createApplicationRuntime({
      paths: {
        database: join(root, 'autoforge.sqlite'),
        data: root,
        logs: join(root, 'logs'),
        projects: join(root, 'projects'),
        installations: join(root, 'workflows'),
        workflowRunner: join(root, 'workflow-runner.cjs'),
        temporary: join(root, 'temporary'),
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(value),
        decrypt: async (value) => ({ value: value.toString(), shouldReEncrypt: false }),
      },
      authService: authenticatedService(session),
      networkProxy,
      browserWorkspace: browserWorkspace(),
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: () => undefined,
      emitExecution: () => undefined,
      conversionRuntimeFactory,
    })

    try {
      await runtime.services.auth.getSession()
      await vi.waitFor(async () => {
        const snapshot = await runtime.services.conversion.listForExecution({ executionId })
        expect(snapshot.jobs[0]).toMatchObject({ status: 'completed' })
        expect(snapshot.jobs[0]?.artifacts).toHaveLength(3)
      }, { timeout: 30_000, interval: 100 })

      expect(conversionRuntimeFactory).toHaveBeenCalledOnce()
      expect(withTransportLease).toHaveBeenCalledOnce()
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        'https://packs.example.test/release/index.json',
        'https://packs.example.test/release/index.sig',
      ])
      const inspection = openAppDatabase(join(root, 'autoforge.sqlite'))
      const artifacts = inspection.conversionArtifacts.listForJob(jobId, ownerUserId)
      expect(artifacts.map((artifact) => artifact.displayName)).toEqual([
        'three-page-page-001.png',
        'three-page-page-002.png',
        'three-page-page-003.png',
      ])
      for (const artifact of artifacts) {
        const bytes = await readFile(join(ownerRoot, artifact.relativePath))
        expect(bytes.subarray(0, 8)).toEqual(Buffer.from('89504e470d0a1a0a', 'hex'))
      }
      inspection.close()
    } finally {
      await runtime.close()
    }
  }, 45_000)
})
