import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import { toSafeAppError, type ConversionTargetFormat } from '@autoforge/shared'
import { sanitizeDisplayName } from '../chat/local-conversion-intent.js'
import type { ConversionJob } from '../database/repositories.js'
import type { NetworkProxyPort } from '../network/network-proxy-service.js'
import { imageIconAdapter } from './adapters/image-icon.js'
import { documentAdapter } from './adapters/document.js'
import { mediaAdapter } from './adapters/media.js'
import { pdfAdapter } from './adapters/pdf.js'
import type {
  ConversionArtifactService,
  ConversionArtifactServiceDatabase,
  ResolvedOwnedInput,
} from './conversion-artifact-service.js'
import type {
  ConversionConcurrencyClass,
  ConversionJobRuntime,
  ManagedConversionAttempt,
} from './conversion-job-runner.js'
import { ConverterPackManager } from './converter-pack-manager.js'
import type {
  ConverterPackName,
  SignedConverterPackIndex,
} from './converter-pack-types.js'
import type {
  ConversionExpectedOutput,
  ConversionProcessPlan,
  ConversionProcessRunner,
  ConverterAdapter,
  ConversionProcessTreePort,
  WindowsJobObjectProcessTreePort,
} from './conversion-process-runner.js'
import {
  createConversionProcessRunner,
  createNodeConversionProcessTreePort,
} from './conversion-process-runner.js'

const adapters = [
  { adapter: imageIconAdapter, pack: 'image-icon' },
  { adapter: documentAdapter, pack: 'document' },
  { adapter: pdfAdapter, pack: 'pdf' },
  { adapter: mediaAdapter, pack: 'media' },
] as const satisfies readonly { adapter: ConverterAdapter; pack: ConverterPackName }[]

interface ProductionConversionJobRuntimeOptions {
  ownerUserId: string
  dataRoot: string
  database: ConversionArtifactServiceDatabase
  artifacts: ConversionArtifactService
  packManager: Pick<ConverterPackManager, 'acquire'>
  signedIndex(signal: AbortSignal): Promise<SignedConverterPackIndex>
  processRunner: ConversionProcessRunner
  adapters?: readonly { adapter: ConverterAdapter; pack: ConverterPackName }[]
}

function failure(code: 'CONVERSION_CANCELLED' | 'CONVERSION_COMPONENT_UNAVAILABLE' | 'CONVERSION_FORMAT_UNSUPPORTED' | 'CONVERSION_INPUT_INVALID' | 'CONVERSION_INTERRUPTED') {
  return toSafeAppError({ code })
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function sameFile(
  left: { dev: number | bigint; ino: number | bigint; size: number },
  right: { dev: number | bigint; ino: number | bigint; size: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
}

function selectedAdapter(
  available: readonly { adapter: ConverterAdapter; pack: ConverterPackName }[],
  input: ResolvedOwnedInput,
  targetFormat: ConversionTargetFormat,
) {
  return available.find(({ adapter }) => adapter.supports(input.probe, targetFormat))
}

function concurrencyClass(job: ConversionJob): ConversionConcurrencyClass {
  if (['pdf', 'xlsx'].includes(job.targetFormat)) return 'document'
  if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'webm', 'mov'].includes(job.targetFormat)) return 'video'
  return 'other'
}

function suffixedName(stem: string, suffix: string): string {
  const available = Math.max(1, 255 - [...suffix].length)
  return `${[...stem].slice(0, available).join('')}${suffix}`
}

function outputNames(
  sourceName: string,
  targetFormat: ConversionTargetFormat,
  plan: ConversionProcessPlan,
): string[] {
  const safe = sanitizeDisplayName(sourceName)
  const extension = extname(safe)
  const stem = basename(safe, extension) || 'converted'
  if (plan.outputContract.kind === 'pdf-pages') {
    return plan.outputs.map((_, index) => suffixedName(stem, `-page-${String(index + 1).padStart(3, '0')}.${targetFormat}`))
  }
  if (plan.outputContract.kind === 'icon-representations') {
    return plan.outputs.map((output, index) => {
      const slot = output.metadata?.iconRepresentation
      if (slot === undefined) {
        return suffixedName(stem, `-representation-${String(index + 1).padStart(3, '0')}.${targetFormat}`)
      }
      const sameSizeCount = plan.outputs.filter((candidate) => {
        const representation = candidate.metadata?.iconRepresentation
        return representation?.sourceType === 'ico'
          && representation.pixelWidth === slot.pixelWidth
          && representation.pixelHeight === slot.pixelHeight
      }).length
      if (slot.sourceType === 'ico' && sameSizeCount > 1) {
        return suffixedName(
          stem,
          `-${slot.pixelWidth}x${slot.pixelHeight}-source-${String(slot.sourceIndex).padStart(3, '0')}.${targetFormat}`,
        )
      }
      return suffixedName(stem, `-${slot.logicalWidth}x${slot.logicalHeight}@${slot.scale}x.${targetFormat}`)
    })
  }
  const sourceExtension = extension.slice(1).toLowerCase()
  return [suffixedName(stem, `${sourceExtension === targetFormat ? '-converted' : ''}.${targetFormat}`)]
}

function validatePlan(
  plan: ConversionProcessPlan,
  targetFormat: ConversionTargetFormat,
  workRoot: string,
): void {
  if (
    plan.outputs.length === 0
    || plan.outputs.length > 256
    || plan.outputPaths.length !== plan.outputs.length
    || (plan.outputContract.kind === 'single' && plan.outputs.length !== 1)
    || (plan.outputContract.kind !== 'single' && plan.outputContract.count !== plan.outputs.length)
  ) throw failure('CONVERSION_INPUT_INVALID')
  const seen = new Set<string>()
  for (const [index, output] of plan.outputs.entries()) {
    const declared = plan.outputPaths[index]
    if (
      output.path !== declared
      || output.format !== targetFormat
      || !isAbsolute(output.path)
      || !inside(workRoot, output.path)
      || dirname(output.path) !== workRoot
      || seen.has(output.path)
    ) throw failure('CONVERSION_INPUT_INVALID')
    if (plan.outputContract.kind === 'pdf-pages' && output.metadata?.pdfPage !== index + 1) {
      throw failure('CONVERSION_INPUT_INVALID')
    }
    seen.add(output.path)
  }
}

async function copyStableOutput(sourcePath: string, destinationPath: string, workRoot: string): Promise<void> {
  const before = await lstat(sourcePath)
  if (before.isSymbolicLink() || !before.isFile()) throw failure('CONVERSION_INPUT_INVALID')
  const sourceRealPath = await realpath(sourcePath)
  if (!inside(workRoot, sourceRealPath)) throw failure('CONVERSION_INPUT_INVALID')
  let source: FileHandle | undefined
  let destination: FileHandle | undefined
  try {
    source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    destination = await open(destinationPath, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW)
    const opened = await source.stat()
    if (!sameFile(before, opened)) throw failure('CONVERSION_INPUT_INVALID')
    const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, before.size)))
    let offset = 0
    while (offset < before.size) {
      const read = await source.read(chunk, 0, Math.min(chunk.byteLength, before.size - offset), offset)
      if (read.bytesRead === 0) throw failure('CONVERSION_INPUT_INVALID')
      let written = 0
      while (written < read.bytesRead) {
        const result = await destination.write(chunk, written, read.bytesRead - written, offset + written)
        if (result.bytesWritten === 0) throw failure('CONVERSION_INPUT_INVALID')
        written += result.bytesWritten
      }
      offset += read.bytesRead
    }
    const after = await source.stat()
    if (!sameFile(opened, after) || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw failure('CONVERSION_INPUT_INVALID')
    }
    await destination.sync()
  } finally {
    await Promise.all([source?.close(), destination?.close()])
  }
}

async function copyPrivateInput(
  source: ResolvedOwnedInput,
  destinationPath: string,
  expectedBytes: number,
  expectedSha256: string,
): Promise<void> {
  const before = await source.handle.stat()
  if (!before.isFile() || before.size !== expectedBytes) throw failure('CONVERSION_INPUT_INVALID')
  let destination: FileHandle | undefined
  try {
    destination = await open(destinationPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o400)
    const created = await destination.stat()
    if (!created.isFile() || created.size !== 0) throw failure('CONVERSION_INPUT_INVALID')
    const hash = createHash('sha256')
    const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, expectedBytes)))
    let offset = 0
    while (offset < expectedBytes) {
      const read = await source.handle.read(chunk, 0, Math.min(chunk.byteLength, expectedBytes - offset), offset)
      if (read.bytesRead === 0) throw failure('CONVERSION_INPUT_INVALID')
      hash.update(chunk.subarray(0, read.bytesRead))
      let written = 0
      while (written < read.bytesRead) {
        const result = await destination.write(chunk, written, read.bytesRead - written, offset + written)
        if (result.bytesWritten === 0) throw failure('CONVERSION_INPUT_INVALID')
        written += result.bytesWritten
      }
      offset += read.bytesRead
    }
    await destination.sync()
    const sourceAfter = await source.handle.stat()
    const destinationAfter = await destination.stat()
    if (
      !sameFile(before, sourceAfter)
      || before.mtimeMs !== sourceAfter.mtimeMs
      || before.ctimeMs !== sourceAfter.ctimeMs
      || !destinationAfter.isFile()
      || destinationAfter.size !== expectedBytes
      || hash.digest('hex') !== expectedSha256
    ) throw failure('CONVERSION_INPUT_INVALID')
    const named = await lstat(destinationPath)
    if (named.isSymbolicLink() || !sameFile(destinationAfter, named)) throw failure('CONVERSION_INPUT_INVALID')
  } finally {
    await destination?.close()
  }
}

async function ownedInput(
  options: ProductionConversionJobRuntimeOptions,
  job: ConversionJob,
): Promise<{ input: ResolvedOwnedInput; displayName: string; byteSize: number; sha256: string }> {
  if (job.ownerUserId !== options.ownerUserId) throw failure('CONVERSION_INPUT_INVALID')
  if (job.sourceKind === 'media') {
    const record = options.database.mediaAssets.get(job.sourceId)
    const conversation = record ? options.database.conversations.get(record.conversationId) : undefined
    if (
      !record
      || conversation?.userId !== options.ownerUserId
      || record.status !== 'ready'
      || !record.mimeType
      || record.byteSize === undefined
      || !record.sha256
    ) throw failure('CONVERSION_INPUT_INVALID')
    return {
      displayName: record.originalName,
      byteSize: record.byteSize,
      sha256: record.sha256,
      input: await options.artifacts.resolveOwnedInput({
        attachmentIndex: 0,
        ownerUserId: options.ownerUserId,
        displayName: record.originalName,
        mimeType: record.mimeType,
        byteSize: record.byteSize,
        source: { kind: 'media', mediaAssetId: record.id },
      }),
    }
  }
  const record = options.database.conversionArtifacts.getOwned(job.sourceId, options.ownerUserId)
  if (!record || record.role !== 'input' || record.status !== 'ready') throw failure('CONVERSION_INPUT_INVALID')
  return {
    displayName: record.displayName,
    byteSize: record.byteSize,
    sha256: record.sha256,
    input: await options.artifacts.resolveOwnedInput({
      attachmentIndex: 0,
      ownerUserId: options.ownerUserId,
      displayName: record.displayName,
      mimeType: record.mimeType,
      byteSize: record.byteSize,
      source: { kind: 'artifact', artifactId: record.id },
    }),
  }
}

/** Production runtime over signed packs, fixed adapters, managed inputs and atomic output batches. */
export function createProductionConversionJobRuntime(
  options: ProductionConversionJobRuntimeOptions,
): ConversionJobRuntime {
  const available = options.adapters ?? adapters
  return {
    concurrencyClass,
    async acquirePack(job, signal) {
      if (signal.aborted) throw failure('CONVERSION_CANCELLED')
      const source = await ownedInput(options, job)
      try {
        const selected = selectedAdapter(available, source.input, job.targetFormat)
        if (!selected) throw failure('CONVERSION_FORMAT_UNSUPPORTED')
        const signedIndex = await options.signedIndex(signal)
        if (signal.aborted) throw failure('CONVERSION_CANCELLED')
        return await options.packManager.acquire({ signedIndex, name: selected.pack })
      } finally {
        await source.input.close().catch(() => undefined)
      }
    },
    async prepare(job, lease, signal): Promise<ManagedConversionAttempt> {
      if (signal.aborted) throw failure('CONVERSION_CANCELLED')
      const source = await ownedInput(options, job)
      let workRoot: string | undefined
      try {
        const selected = selectedAdapter(available, source.input, job.targetFormat)
        if (!selected || selected.pack !== lease.name) throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
        const temporary = join(options.dataRoot, 'temporary')
        await mkdir(temporary, { recursive: true, mode: 0o700 })
        const temporaryMetadata = await lstat(temporary)
        if (temporaryMetadata.isSymbolicLink() || !temporaryMetadata.isDirectory()) throw failure('CONVERSION_INPUT_INVALID')
        const dataRootRealPath = await realpath(options.dataRoot)
        const temporaryRealPath = await realpath(temporary)
        if (!inside(dataRootRealPath, temporaryRealPath)) throw failure('CONVERSION_INPUT_INVALID')
        workRoot = await realpath(await mkdtemp(join(temporaryRealPath, 'converter-')))
        const workMetadata = await lstat(workRoot)
        if (workMetadata.isSymbolicLink() || !workMetadata.isDirectory()) throw failure('CONVERSION_INPUT_INVALID')
        const privateInputPath = join(workRoot, `input.${source.input.probe.format}`)
        await copyPrivateInput(source.input, privateInputPath, source.byteSize, source.sha256)
        const plan = selected.adapter.plan(source.input.probe, {
          inputPath: privateInputPath,
          targetFormat: job.targetFormat,
          ...(job.preset === undefined ? {} : { preset: job.preset }),
        }, lease, workRoot)
        validatePlan(plan, job.targetFormat, workRoot)
        const names = outputNames(source.displayName, job.targetFormat, plan)
        const batch = await options.artifacts.createOutputBatch(plan.outputs.map((_, index) => ({
          ownerUserId: job.ownerUserId,
          executionId: job.executionId,
          conversionJobId: job.id,
          displayName: names[index]!,
          targetFormat: job.targetFormat,
        })))
        if (batch.outputs.length !== plan.outputs.length) throw failure('CONVERSION_INPUT_INVALID')
        let executed = false
        let cleaned = false
        const cleanup = async () => {
          if (cleaned) return
          cleaned = true
          await source.input.close().catch(() => undefined)
          await rm(workRoot!, { recursive: true, force: true }).catch(() => undefined)
        }
        return {
          atomicJobCompletion: true,
          async execute(executionOptions) {
            if (executionOptions.signal.aborted) throw failure('CONVERSION_CANCELLED')
            executionOptions.onProgress(20)
            await options.processRunner.run(plan, lease, { signal: executionOptions.signal })
            if (executionOptions.signal.aborted) throw failure('CONVERSION_CANCELLED')
            for (const [index, output] of plan.outputs.entries()) {
              await copyStableOutput(output.path, batch.outputs[index]!.tempPath, workRoot!)
              if (executionOptions.signal.aborted) throw failure('CONVERSION_CANCELLED')
              executionOptions.onProgress(20 + Math.floor(((index + 1) / plan.outputs.length) * 70))
            }
            executed = true
          },
          async commit({ endedAt }) {
            if (!executed) throw failure('CONVERSION_INTERRUPTED')
            try {
              return await batch.commit(plan.outputs.map((output: ConversionExpectedOutput) => (
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
        await source.input.close().catch(() => undefined)
        if (workRoot) await rm(workRoot, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
    },
  }
}

const requiredPackFamilies = ['image-icon', 'document', 'pdf', 'media'] as const
const supportedReleaseTargets = ['darwin-arm64', 'darwin-x64', 'win32-x64'] as const
const maximumBootstrapBytes = 64 * 1024
const maximumIndexBytes = 1024 * 1024
const maximumSignatureBytes = 4 * 1024

interface ProductionReleaseConfig {
  readonly indexUrl: string
  readonly signatureUrl: string
  readonly rootPublicKeyPem: Buffer
}

export interface ProductionConversionRuntimeFactoryContext {
  ownerUserId: string
  dataRoot: string
  packsRoot: string
  database: ConversionArtifactServiceDatabase
  artifacts: ConversionArtifactService
}

export interface ProductionConversionRuntimeBinding {
  packManager: ConverterPackManager
  runtime: ConversionJobRuntime
}

export type ProductionConversionRuntimeFactory = (
  context: ProductionConversionRuntimeFactoryContext,
) => Promise<ProductionConversionRuntimeBinding>

export interface ProductionConversionRuntimeFactoryOptions {
  resourcesRoot: string
  network: Pick<NetworkProxyPort, 'fetch' | 'withTransportLease'>
  platform?: NodeJS.Platform
  arch?: string
  processTree?: ConversionProcessTreePort
  windowsJobObject?: WindowsJobObjectProcessTreePort
  /** @internal Deterministic no-follow resource race seam for focused Main tests. */
  resourceFileOpen?: (path: string, flags: number) => Promise<FileHandle>
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.values(descriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function exactStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index])
}

function releaseUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048 || value !== value.trim() || value.includes('\\')) {
    throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
  }
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.hash !== ''
    || url.search !== ''
    || basename(url.pathname) !== 'index.json'
  ) throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
  return url
}

async function canonicalRegularFile(
  root: string,
  name: string,
  maximumBytes: number,
  openResourceFile: (path: string, flags: number) => Promise<FileHandle>,
): Promise<Buffer> {
  if (basename(name) !== name || name.includes('\\') || name.includes('\0')) throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
  const path = join(root, name)
  const rootBefore = await lstat(root)
  const before = await lstat(path)
  if (
    rootBefore.isSymbolicLink()
    || !rootBefore.isDirectory()
    || before.isSymbolicLink()
    || !before.isFile()
    || before.nlink !== 1
    || before.size <= 0
    || before.size > maximumBytes
  ) throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
  let handle: FileHandle | undefined
  try {
    handle = await openResourceFile(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await handle.stat()
    const named = await lstat(path)
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || named.isSymbolicLink()
      || !sameFile(before, opened)
      || !sameFile(opened, named)
    ) throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
    const bytes = Buffer.allocUnsafe(opened.size)
    let offset = 0
    while (offset < opened.size) {
      const result = await handle.read(bytes, offset, opened.size - offset, offset)
      if (result.bytesRead === 0) throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
      offset += result.bytesRead
    }
    const after = await handle.stat()
    const namedAfter = await lstat(path)
    const rootAfter = await lstat(root)
    if (
      !sameFile(opened, after)
      || opened.mtimeMs !== after.mtimeMs
      || opened.ctimeMs !== after.ctimeMs
      || !sameFile(after, namedAfter)
      || rootBefore.dev !== rootAfter.dev
      || rootBefore.ino !== rootAfter.ino
      || await realpath(root) !== root
    ) throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
    return bytes
  } finally {
    await handle?.close()
  }
}

async function loadProductionRelease(
  resourcesRoot: string,
  platform: NodeJS.Platform,
  arch: string,
  openResourceFile: (path: string, flags: number) => Promise<FileHandle>,
): Promise<ProductionReleaseConfig> {
  try {
    if (!isAbsolute(resourcesRoot)) throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
    const rootMetadata = await lstat(resourcesRoot)
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
    const root = await realpath(resourcesRoot)
    const bootstrapBytes = await canonicalRegularFile(root, 'bootstrap.json', maximumBootstrapBytes, openResourceFile)
    const bootstrap = JSON.parse(bootstrapBytes.toString('utf8')) as unknown
    const keys = [
      'schemaVersion', 'downloadsEnabled', 'indexUrl', 'rootPublicKeyFile',
      'requiredPackFamilies', 'supportedTargets',
    ]
    if (
      !exactObject(bootstrap, keys)
      || bootstrap.schemaVersion !== 1
      || !exactStrings(bootstrap.requiredPackFamilies, requiredPackFamilies)
      || !exactStrings(bootstrap.supportedTargets, supportedReleaseTargets)
      || typeof bootstrap.downloadsEnabled !== 'boolean'
      || !supportedReleaseTargets.includes(`${platform}-${arch}` as typeof supportedReleaseTargets[number])
    ) throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
    if (bootstrap.downloadsEnabled !== true) {
      if (bootstrap.indexUrl !== null || bootstrap.rootPublicKeyFile !== null) {
        throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
      }
      throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
    }
    if (bootstrap.rootPublicKeyFile !== 'root-public-key.pem') throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
    const index = releaseUrl(bootstrap.indexUrl)
    const signature = new URL('index.sig', index)
    const rootPublicKeyPem = await canonicalRegularFile(root, bootstrap.rootPublicKeyFile, maximumBootstrapBytes, openResourceFile)
    return { indexUrl: index.href, signatureUrl: signature.href, rootPublicKeyPem }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'CONVERSION_COMPONENT_UNAVAILABLE') {
      throw error
    }
    throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
  }
}

async function boundedResponse(response: Response, expectedUrl: string, maximumBytes: number): Promise<Buffer> {
  if (!response.ok || response.status !== 200 || response.redirected || (response.url && response.url !== expectedUrl)) {
    throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
  }
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^(?:0|[1-9]\d*)$/u.test(declared) || Number(declared) > maximumBytes)) {
    throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
  }
  if (!response.body) throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (!Number.isSafeInteger(total) || total > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  if (total === 0) throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
  return Buffer.concat(chunks, total)
}

async function fetchSignedIndex(
  release: ProductionReleaseConfig,
  network: ProductionConversionRuntimeFactoryOptions['network'],
  signal: AbortSignal,
): Promise<SignedConverterPackIndex> {
  if (signal.aborted) throw failure('CONVERSION_CANCELLED')
  try {
    return await network.withTransportLease(async () => {
      const init: RequestInit = {
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal,
      }
      const indexResponse = await network.fetch(release.indexUrl, init)
      const indexBytes = await boundedResponse(indexResponse, release.indexUrl, maximumIndexBytes)
      const signatureResponse = await network.fetch(release.signatureUrl, init)
      const signatureBytes = await boundedResponse(signatureResponse, release.signatureUrl, maximumSignatureBytes)
      let index: unknown
      try {
        index = JSON.parse(indexBytes.toString('utf8'))
      } catch {
        throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
      }
      const signature = signatureBytes.toString('ascii').trim()
      if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(signature) || signature.length > 512) {
        throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
      }
      return { index, signature }
    })
  } catch (error) {
    if (signal.aborted) throw failure('CONVERSION_CANCELLED')
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'CONVERSION_COMPONENT_UNAVAILABLE') {
      throw error
    }
    throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
  }
}

/** Creates the owner-bound runtime used by the ordinary Electron Main entrypoint. */
export function createProductionConversionRuntimeFactory(
  options: ProductionConversionRuntimeFactoryOptions,
): ProductionConversionRuntimeFactory {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  let releaseTask: Promise<ProductionReleaseConfig> | undefined
  const release = () => (releaseTask ??= loadProductionRelease(
    options.resourcesRoot,
    platform,
    arch,
    options.resourceFileOpen ?? ((path, flags) => open(path, flags)),
  ))
  let processRunner: ConversionProcessRunner | undefined
  try {
    const processTree = options.processTree ?? createNodeConversionProcessTreePort({
      platform,
      ...(options.windowsJobObject === undefined ? {} : { windowsJobObject: options.windowsJobObject }),
    })
    processRunner = createConversionProcessRunner({ processTree })
  } catch {
    // Windows remains fail-closed until a real Job Object port is injected.
  }

  return async (context) => {
    let loaded: ProductionReleaseConfig | undefined
    if (processRunner !== undefined) loaded = await release().catch(() => undefined)
    const packManager = new ConverterPackManager({
      packsRoot: context.packsRoot,
      ...(loaded === undefined ? {} : { rootPublicKeyPem: loaded.rootPublicKeyPem }),
      platform,
      arch,
    })
    const signedIndex = loaded === undefined
      ? async (): Promise<never> => { throw failure('CONVERSION_COMPONENT_UNAVAILABLE') }
      : (signal: AbortSignal) => fetchSignedIndex(loaded!, options.network, signal)
    const unavailableRunner: ConversionProcessRunner = {
      async run() { throw failure('CONVERSION_COMPONENT_UNAVAILABLE') },
    }
    return {
      packManager,
      runtime: createProductionConversionJobRuntime({
        ownerUserId: context.ownerUserId,
        dataRoot: context.dataRoot,
        database: context.database,
        artifacts: context.artifacts,
        packManager,
        signedIndex,
        processRunner: processRunner ?? unavailableRunner,
      }),
    }
  }
}
