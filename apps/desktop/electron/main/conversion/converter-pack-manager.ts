import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
} from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import {
  ConverterPackError,
  CONVERTER_PACK_NAMES,
  type ConverterPackDescriptor,
  type ConverterPackLease,
  type ConverterPackName,
  type ConverterPackArchitecture,
  type ConverterPackPlatform,
  type ConverterPackReference,
  type SignedConverterPackIndex,
} from './converter-pack-types.js'
import {
  approvedConverterPackTarget,
  compareSemanticVersions,
  converterPackPortablePathKey,
  DEFAULT_CONVERTER_PACK_LIMITS,
  isConverterPackVersion,
  safeConverterPackEntryPath,
  selectConverterPack,
  verifyConverterPackIndex,
  type ConverterPackVerificationLimits,
} from './converter-pack-verifier.js'

const partialNamePattern = /^\.partial-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const redirectStatuses = new Set([301, 302, 303, 307, 308])
const maximumRedirects = 5
const defaultRequestTimeoutMs = 120_000
const maximumRequestTimeoutMs = 10 * 60_000
const tarBlockBytes = 512
const sequenceDirectoryName = '.index-sequences'
const sequenceMarkerPattern = /^(?:0|[1-9]\d*)$/u
const sequencePartialPattern = /^\.sequence-(?:0|[1-9]\d*)\.partial-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const restrictedUstarMagic = Buffer.from('ustar\0', 'ascii')
const restrictedUstarVersion = Buffer.from('00', 'ascii')
const sequenceTails = new Map<string, Promise<void>>()

export interface ConverterPackSequenceFile {
  write(value: string): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

export interface ConverterPackSequencePersistence {
  openExclusive(path: string): Promise<ConverterPackSequenceFile>
  rename(source: string, destination: string): Promise<void>
  syncDirectory(path: string): Promise<void>
}

const nodeSequencePersistence: ConverterPackSequencePersistence = Object.freeze({
  async openExclusive(path: string): Promise<ConverterPackSequenceFile> {
    const handle = await open(path, 'wx', 0o600)
    return {
      write: async (value) => { await handle.writeFile(value, 'utf8') },
      sync: async () => { await handle.sync() },
      close: async () => { await handle.close() },
    }
  },
  rename: async (source: string, destination: string) => { await rename(source, destination) },
  async syncDirectory(path: string): Promise<void> {
    const handle = await open(path, constants.O_RDONLY)
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  },
})

export interface ConverterPackManagerOptions {
  packsRoot: string
  rootPublicKeyPem?: string | Buffer
  platform?: string
  arch?: string
  tlsCa?: string | Buffer
  maxRedirects?: number
  requestTimeoutMs?: number
  limits?: Partial<ConverterPackVerificationLimits>
  sequencePersistence?: ConverterPackSequencePersistence
}

export interface AcquireConverterPackInput {
  signedIndex: SignedConverterPackIndex
  name: ConverterPackName
  version?: string
}

export interface CleanupConverterPacksInput {
  currentVersions?: readonly ConverterPackReference[]
  jobReferences?: readonly ConverterPackReference[]
}

interface InstalledPack extends ConverterPackReference {
  root: string
  executables: Readonly<Record<string, string>>
}

function failure(reason: ConstructorParameters<typeof ConverterPackError>[0]): never {
  throw new ConverterPackError(reason)
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function exactReferenceKey(reference: ConverterPackReference): string {
  return `${reference.name}\0${reference.version}\0${reference.platform}\0${reference.arch}`
}

function familyKey(reference: Pick<ConverterPackReference, 'name' | 'platform' | 'arch'>): string {
  return `${reference.name}\0${reference.platform}\0${reference.arch}`
}

function validatedHttpsUrl(value: string, reason: 'redirect_invalid' | 'download_failed'): URL {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 2_048
    || value !== value.trim()
    || value.includes('\\')
    || [...value].some((character) => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f)
  ) failure(reason)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    failure(reason)
  }
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.hash !== ''
    || url.hostname.length === 0
  ) failure(reason)
  return url
}

function redirectedUrl(location: string, base: URL): URL {
  if (
    typeof location !== 'string'
    || location.length === 0
    || location !== location.trim()
    || location.includes('\\')
    || location.startsWith('//')
  ) failure('redirect_invalid')
  let resolved: URL
  try {
    resolved = new URL(location, base)
  } catch {
    failure('redirect_invalid')
  }
  return validatedHttpsUrl(resolved.href, 'redirect_invalid')
}

function rawHeaderValues(response: IncomingMessage, name: string): string[] {
  const values: string[] = []
  if (response.rawHeaders.length % 2 !== 0) failure('download_failed')
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    if (response.rawHeaders[index]!.toLowerCase() === name) values.push(response.rawHeaders[index + 1]!)
  }
  return values
}

function singleHeader(response: IncomingMessage, name: string): string | undefined {
  const values = rawHeaderValues(response, name)
  if (values.length > 1) failure('download_failed')
  return values[0]
}

async function writeAll(handle: FileHandle, bytes: Buffer, position: number): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset)
    if (result.bytesWritten <= 0) failure('install_failed')
    offset += result.bytesWritten
  }
}

async function readExact(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const result = await handle.read(bytes, offset, length - offset, position + offset)
    if (result.bytesRead === 0) failure('archive_entry_invalid')
    offset += result.bytesRead
  }
  return bytes
}

function isZeroBlock(block: Buffer): boolean {
  return block.every((value) => value === 0)
}

function tarString(block: Buffer, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length)
  const end = field.indexOf(0)
  if (end !== -1 && !field.subarray(end + 1).every((value) => value === 0)) failure('archive_entry_invalid')
  const bytes = end === -1 ? field : field.subarray(0, end)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    failure('archive_entry_invalid')
  }
}

function restrictedTarOctal(block: Buffer, offset: number, length: number): number {
  const field = block.subarray(offset, offset + length)
  if (
    field.byteLength !== length
    || field[length - 1] !== 0
    || !field.subarray(0, length - 1).every((value) => value >= 0x30 && value <= 0x37)
  ) failure('archive_entry_invalid')
  const parsed = Number.parseInt(field.subarray(0, length - 1).toString('ascii'), 8)
  if (!Number.isSafeInteger(parsed)) failure('archive_entry_invalid')
  return parsed
}

function verifyTarChecksum(block: Buffer): void {
  const checksum = block.subarray(148, 156)
  if (
    checksum[6] !== 0
    || checksum[7] !== 0x20
    || !checksum.subarray(0, 6).every((value) => value >= 0x30 && value <= 0x37)
  ) failure('archive_entry_invalid')
  const declared = Number.parseInt(checksum.subarray(0, 6).toString('ascii'), 8)
  const copy = Buffer.from(block)
  copy.fill(0x20, 148, 156)
  const actual = copy.reduce((sum, value) => sum + value, 0)
  if (actual !== declared) failure('archive_entry_invalid')
}

function verifyRestrictedUstarHeader(block: Buffer): void {
  if (
    !block.subarray(257, 263).equals(restrictedUstarMagic)
    || !block.subarray(263, 265).equals(restrictedUstarVersion)
    || block[156] !== 0x30
    || !block.subarray(157, 257).every((value) => value === 0)
    || restrictedTarOctal(block, 108, 8) !== 0
    || restrictedTarOctal(block, 116, 8) !== 0
    || restrictedTarOctal(block, 136, 12) !== 0
    || !block.subarray(265, 345).every((value) => value === 0)
    || !block.subarray(500, tarBlockBytes).every((value) => value === 0)
  ) failure('archive_entry_invalid')
}

async function ensureChildDirectory(root: string, segments: readonly string[]): Promise<string> {
  let parent = root
  for (const segment of segments) {
    const child = join(parent, segment)
    try {
      await mkdir(child, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const metadata = await lstat(child)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) failure('install_failed')
    const resolved = await realpath(child)
    if (!inside(root, resolved)) failure('install_failed')
    parent = child
  }
  return parent
}

async function hashRegularFile(root: string, path: string, expectedBytes: number): Promise<string> {
  const before = await lstat(path)
  if (before.isSymbolicLink() || !before.isFile() || before.size !== expectedBytes) failure('installed_pack_invalid')
  const resolved = await realpath(path)
  if (!inside(root, resolved)) failure('installed_pack_invalid')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      failure('installed_pack_invalid')
    }
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let position = 0
    while (position < expectedBytes) {
      const result = await handle.read(buffer, 0, Math.min(buffer.byteLength, expectedBytes - position), position)
      if (result.bytesRead === 0) failure('installed_pack_invalid')
      hash.update(buffer.subarray(0, result.bytesRead))
      position += result.bytesRead
    }
    const after = await lstat(path)
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      failure('installed_pack_invalid')
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

async function verifyInstalledPack(
  root: string,
  descriptor: ConverterPackDescriptor,
  managedRoot: string,
): Promise<InstalledPack> {
  let canonicalRoot: string
  try {
    const rootMetadata = await lstat(root)
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) failure('installed_pack_invalid')
    canonicalRoot = await realpath(root)
    if (!inside(managedRoot, canonicalRoot)) failure('installed_pack_invalid')
  } catch (error) {
    if (error instanceof ConverterPackError) throw error
    failure('installed_pack_invalid')
  }

  const expectedFiles = new Map(descriptor.entries.map((entry) => [entry.path, entry]))
  const expectedDirectories = new Set<string>()
  for (const entry of descriptor.entries) {
    let parent = dirname(entry.path)
    while (parent !== '.') {
      expectedDirectories.add(parent)
      parent = dirname(parent)
    }
  }
  const discovered = new Set<string>()
  const visit = async (directory: string, prefix = ''): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (!safeConverterPackEntryPath(relativePath)) failure('installed_pack_invalid')
      const absolutePath = join(directory, entry.name)
      const metadata = await lstat(absolutePath)
      if (metadata.isSymbolicLink()) failure('installed_pack_invalid')
      if (metadata.isDirectory()) {
        if (!expectedDirectories.has(relativePath)) failure('installed_pack_invalid')
        await visit(absolutePath, relativePath)
        continue
      }
      const collisionKey = converterPackPortablePathKey(relativePath)
      if (!metadata.isFile() || !expectedFiles.has(relativePath) || discovered.has(collisionKey)) {
        failure('installed_pack_invalid')
      }
      discovered.add(collisionKey)
    }
  }
  try {
    await visit(canonicalRoot)
  } catch (error) {
    if (error instanceof ConverterPackError) throw error
    failure('installed_pack_invalid')
  }
  if (discovered.size !== expectedFiles.size) failure('installed_pack_invalid')

  const executables: Record<string, string> = {}
  for (const entry of descriptor.entries) {
    const path = join(canonicalRoot, ...entry.path.split('/'))
    const actualHash = await hashRegularFile(canonicalRoot, path, entry.bytes)
    if (actualHash !== entry.sha256) failure('installed_pack_invalid')
    const metadata = await lstat(path)
    if (descriptor.platform === 'darwin' && (metadata.mode & 0o777) !== (entry.executable ? 0o755 : 0o644)) {
      failure('installed_pack_invalid')
    }
    if (entry.executable) executables[entry.path] = path
  }
  return Object.freeze({
    name: descriptor.name,
    version: descriptor.version,
    platform: descriptor.platform,
    arch: descriptor.arch,
    root: canonicalRoot,
    executables: Object.freeze(executables),
  })
}

async function extractTar(
  archivePath: string,
  destinationRoot: string,
  descriptor: ConverterPackDescriptor,
  limits: ConverterPackVerificationLimits,
): Promise<void> {
  const expected = new Map(descriptor.entries.map((entry) => [entry.path, entry]))
  const seen = new Set<string>()
  let expandedBytes = 0
  let archive: FileHandle | undefined
  try {
    archive = await open(archivePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const archiveMetadata = await archive.stat()
    if (!archiveMetadata.isFile() || archiveMetadata.size !== descriptor.archiveBytes || archiveMetadata.size % tarBlockBytes !== 0) {
      failure('archive_entry_invalid')
    }
    let position = 0
    let terminators = 0
    while (position < archiveMetadata.size) {
      const header = await readExact(archive, position, tarBlockBytes)
      position += tarBlockBytes
      if (isZeroBlock(header)) {
        terminators += 1
        if (terminators >= 2) {
          while (position < archiveMetadata.size) {
            const trailing = await readExact(archive, position, tarBlockBytes)
            if (!isZeroBlock(trailing)) failure('archive_entry_invalid')
            position += tarBlockBytes
          }
          break
        }
        continue
      }
      if (terminators !== 0) failure('archive_entry_invalid')
      verifyTarChecksum(header)
      verifyRestrictedUstarHeader(header)
      const name = tarString(header, 0, 100)
      const prefix = tarString(header, 345, 155)
      const path = prefix ? `${prefix}/${name}` : name
      if (!safeConverterPackEntryPath(path)) failure('archive_entry_invalid')
      const collisionKey = converterPackPortablePathKey(path)
      if (seen.has(collisionKey)) failure('archive_entry_invalid')
      const expectedEntry = expected.get(path)
      if (!expectedEntry) failure('archive_entry_invalid')
      const size = restrictedTarOctal(header, 124, 12)
      const mode = restrictedTarOctal(header, 100, 8)
      const expectedMode = expectedEntry.executable ? 0o755 : 0o644
      if (size !== expectedEntry.bytes || mode !== expectedMode || size > limits.maxEntryBytes) {
        failure('archive_entry_invalid')
      }
      expandedBytes += size
      if (expandedBytes > limits.maxExpandedBytes || seen.size + 1 > limits.maxEntries) {
        failure('archive_entry_invalid')
      }

      const segments = path.split('/')
      await ensureChildDirectory(destinationRoot, segments.slice(0, -1))
      const destination = join(destinationRoot, ...segments)
      const output = await open(
        destination,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        expectedMode,
      )
      const hash = createHash('sha256')
      try {
        let remaining = size
        let outputPosition = 0
        while (remaining > 0) {
          const chunkLength = Math.min(64 * 1024, remaining)
          const chunk = await readExact(archive, position, chunkLength)
          await writeAll(output, chunk, outputPosition)
          hash.update(chunk)
          position += chunkLength
          outputPosition += chunkLength
          remaining -= chunkLength
        }
        await output.sync()
      } finally {
        await output.close()
      }
      await chmod(destination, expectedMode)
      if (hash.digest('hex') !== expectedEntry.sha256) failure('entry_hash_mismatch')
      seen.add(collisionKey)

      const padding = (tarBlockBytes - (size % tarBlockBytes)) % tarBlockBytes
      if (padding > 0) {
        const paddingBytes = await readExact(archive, position, padding)
        if (!paddingBytes.every((value) => value === 0)) failure('archive_entry_invalid')
        position += padding
      }
    }
    if (terminators < 2 || seen.size !== expected.size) failure('archive_entry_invalid')
  } catch (error) {
    if (error instanceof ConverterPackError) throw error
    failure('archive_entry_invalid')
  } finally {
    await archive?.close()
  }
}

async function safeTreeForRemoval(root: string, path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) return false
    const resolved = await realpath(path)
    if (!inside(root, resolved)) return false
    if (metadata.isFile()) return true
    const children = await readdir(path)
    for (const child of children) {
      if (!await safeTreeForRemoval(root, join(path, child))) return false
    }
    return true
  } catch {
    return false
  }
}

export class ConverterPackManager {
  private readonly packsRoot: string
  private readonly rootPublicKeyPem: string | Buffer | undefined
  private readonly tlsCa: string | Buffer | undefined
  private readonly platform: string
  private readonly arch: string
  private readonly maxRedirects: number
  private readonly requestTimeoutMs: number
  private readonly limits: ConverterPackVerificationLimits
  private readonly sequencePersistence: ConverterPackSequencePersistence
  private initializePromise?: Promise<void>
  private canonicalRoot?: string
  private lifecycleTail = Promise.resolve()
  private readonly inFlight = new Map<string, Promise<InstalledPack>>()
  private readonly activeLeases = new Map<string, number>()
  private readonly currentVersions = new Map<string, string>()

  constructor(options: ConverterPackManagerOptions) {
    this.packsRoot = options.packsRoot
    this.rootPublicKeyPem = typeof options.rootPublicKeyPem === 'string'
      ? options.rootPublicKeyPem
      : options.rootPublicKeyPem === undefined ? undefined : Buffer.from(options.rootPublicKeyPem)
    this.tlsCa = typeof options.tlsCa === 'string'
      ? options.tlsCa
      : options.tlsCa === undefined ? undefined : Buffer.from(options.tlsCa)
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.maxRedirects = options.maxRedirects ?? 3
    this.requestTimeoutMs = options.requestTimeoutMs ?? defaultRequestTimeoutMs
    this.limits = { ...DEFAULT_CONVERTER_PACK_LIMITS, ...options.limits }
    this.sequencePersistence = options.sequencePersistence ?? nodeSequencePersistence
    if (
      typeof options.packsRoot !== 'string'
      || options.packsRoot.length === 0
      || !Number.isInteger(this.maxRedirects)
      || this.maxRedirects < 0
      || this.maxRedirects > maximumRedirects
      || !Number.isInteger(this.requestTimeoutMs)
      || this.requestTimeoutMs <= 0
      || this.requestTimeoutMs > maximumRequestTimeoutMs
    ) failure('install_failed')
  }

  initialize(): Promise<void> {
    this.initializePromise ??= this.initializeRoot()
    return this.initializePromise
  }

  private async initializeRoot(): Promise<void> {
    try {
      await mkdir(this.packsRoot, { recursive: true, mode: 0o700 })
      const metadata = await lstat(this.packsRoot)
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) failure('install_failed')
      this.canonicalRoot = await realpath(this.packsRoot)
      for (const entry of await readdir(this.canonicalRoot, { withFileTypes: true })) {
        if (!partialNamePattern.test(entry.name)) continue
        await rm(join(this.canonicalRoot, entry.name), { recursive: true, force: true })
      }
    } catch (error) {
      if (error instanceof ConverterPackError) throw error
      failure('install_failed')
    }
  }

  private root(): string {
    if (!this.canonicalRoot) failure('install_failed')
    return this.canonicalRoot
  }

  private async highestSequence(): Promise<number> {
    const directory = await ensureChildDirectory(this.root(), [sequenceDirectoryName])
    let highest = 0
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (sequencePartialPattern.test(entry.name)) {
        try {
          await rm(join(directory, entry.name), { force: true })
        } catch {
          failure('sequence_state_invalid')
        }
        continue
      }
      if (!entry.isFile() || !sequenceMarkerPattern.test(entry.name)) failure('sequence_state_invalid')
      const sequence = Number(entry.name)
      if (!Number.isSafeInteger(sequence)) failure('sequence_state_invalid')
      try {
        if (await readFile(join(directory, entry.name), 'utf8') !== `${entry.name}\n`) failure('sequence_state_invalid')
      } catch (error) {
        if (error instanceof ConverterPackError) throw error
        failure('sequence_state_invalid')
      }
      highest = Math.max(highest, sequence)
    }
    return highest
  }

  private async persistSequence(directory: string, sequence: number): Promise<void> {
    const temporaryPath = join(directory, `.sequence-${sequence}.partial-${randomUUID()}`)
    const markerPath = join(directory, String(sequence))
    let handle: ConverterPackSequenceFile | undefined
    try {
      handle = await this.sequencePersistence.openExclusive(temporaryPath)
      await handle.write(`${sequence}\n`)
      await handle.sync()
      await handle.close()
      handle = undefined
      await this.sequencePersistence.rename(temporaryPath, markerPath)
      await this.sequencePersistence.syncDirectory(directory)
    } finally {
      await handle?.close().catch(() => undefined)
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }

  private async verifyAndRecordIndex(signedIndex: SignedConverterPackIndex) {
    const lockKey = this.root()
    let release!: () => void
    const previous = sequenceTails.get(lockKey) ?? Promise.resolve()
    const current = new Promise<void>((resolve) => { release = resolve })
    sequenceTails.set(lockKey, current)
    await previous
    try {
      const minimumSequence = await this.highestSequence()
      const index = verifyConverterPackIndex({
        index: signedIndex.index,
        signature: signedIndex.signature,
        rootPublicKeyPem: this.rootPublicKeyPem,
        minimumSequence,
        limits: this.limits,
      })
      if (index.sequence > minimumSequence) {
        const directory = join(this.root(), sequenceDirectoryName)
        await this.persistSequence(directory, index.sequence)
      }
      return index
    } finally {
      release()
      if (sequenceTails.get(lockKey) === current) sequenceTails.delete(lockKey)
    }
  }

  private async withLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void
    const previous = this.lifecycleTail
    this.lifecycleTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  async acquire(input: AcquireConverterPackInput): Promise<ConverterPackLease> {
    await this.initialize()
    const index = await this.verifyAndRecordIndex(input.signedIndex)
    const descriptor = selectConverterPack(index, {
      name: input.name,
      ...(input.version === undefined ? {} : { version: input.version }),
      platform: this.platform as never,
      arch: this.arch as never,
    })
    const coordinate = exactReferenceKey(descriptor)
    const flightKey = `${coordinate}\0${descriptor.archiveSha256}`
    let installing = this.inFlight.get(flightKey)
    if (!installing) {
      installing = this.resolveOrInstall(descriptor)
      this.inFlight.set(flightKey, installing)
      void installing.finally(() => {
        if (this.inFlight.get(flightKey) === installing) this.inFlight.delete(flightKey)
      }).catch(() => undefined)
    }
    await installing
    return this.withLifecycleLock(async () => {
      // Cleanup may have removed an unleased old version after the initial
      // resolution. Re-resolve while lease admission and removal are serialized.
      const installed = await this.resolveOrInstall(descriptor)
      const family = familyKey(installed)
      const current = this.currentVersions.get(family)
      if (current === undefined || compareSemanticVersions(installed.version, current) > 0) {
        this.currentVersions.set(family, installed.version)
      }
      this.activeLeases.set(coordinate, (this.activeLeases.get(coordinate) ?? 0) + 1)
      let released = false
      return Object.freeze({
        ...installed,
        release: () => {
          if (released) return
          released = true
          const active = this.activeLeases.get(coordinate) ?? 0
          if (active <= 1) this.activeLeases.delete(coordinate)
          else this.activeLeases.set(coordinate, active - 1)
        },
      })
    })
  }

  private installationRoot(descriptor: ConverterPackReference): string {
    return join(this.root(), descriptor.name, descriptor.version, `${descriptor.platform}-${descriptor.arch}`)
  }

  private async resolveOrInstall(descriptor: ConverterPackDescriptor): Promise<InstalledPack> {
    const finalRoot = this.installationRoot(descriptor)
    try {
      await lstat(finalRoot)
      return verifyInstalledPack(finalRoot, descriptor, this.root())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const partialRoot = join(this.root(), `.partial-${randomUUID()}`)
    const archivePath = join(partialRoot, 'pack.tar')
    const extractionRoot = join(partialRoot, 'root')
    try {
      await mkdir(partialRoot, { mode: 0o700 })
      await mkdir(extractionRoot, { mode: 0o700 })
      await this.download(descriptor, archivePath)
      await extractTar(archivePath, extractionRoot, descriptor, this.limits)
      await verifyInstalledPack(extractionRoot, descriptor, this.root())
      await ensureChildDirectory(this.root(), [descriptor.name, descriptor.version])
      try {
        await rename(extractionRoot, finalRoot)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        return verifyInstalledPack(finalRoot, descriptor, this.root())
      }
      return verifyInstalledPack(finalRoot, descriptor, this.root())
    } catch (error) {
      if (error instanceof ConverterPackError) throw error
      failure('install_failed')
    } finally {
      await rm(partialRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private request(url: URL): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const options: RequestOptions = {
        method: 'GET',
        agent: false,
        ...(this.tlsCa === undefined ? {} : { ca: this.tlsCa }),
      }
      const request = httpsRequest(url, options, resolve)
      request.once('error', reject)
      request.setTimeout(this.requestTimeoutMs, () => request.destroy(new Error('Converter pack request timed out')))
      request.end()
    })
  }

  private async download(descriptor: ConverterPackDescriptor, destination: string): Promise<void> {
    let currentUrl = validatedHttpsUrl(descriptor.archiveUrl, 'download_failed')
    let redirects = 0
    try {
      while (true) {
        const response = await this.request(currentUrl)
        const status = response.statusCode ?? 0
        if (redirectStatuses.has(status)) {
          if (redirects >= this.maxRedirects) {
            response.destroy()
            failure('redirect_limit')
          }
          const location = singleHeader(response, 'location')
          if (!location) {
            response.destroy()
            failure('redirect_invalid')
          }
          const nextUrl = redirectedUrl(location, currentUrl)
          response.destroy()
          redirects += 1
          currentUrl = nextUrl
          continue
        }
        if (status !== 200) {
          response.destroy()
          failure('download_failed')
        }
        const declaredLength = singleHeader(response, 'content-length')
        if (declaredLength !== undefined) {
          if (!/^(?:0|[1-9]\d*)$/u.test(declaredLength) || Number(declaredLength) !== descriptor.archiveBytes) {
            response.destroy()
            failure('archive_size_mismatch')
          }
        }
        const output = await open(destination, 'wx', 0o600)
        const hash = createHash('sha256')
        let bytesWritten = 0
        try {
          for await (const value of response) {
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
            bytesWritten += chunk.byteLength
            if (bytesWritten > descriptor.archiveBytes || bytesWritten > this.limits.maxArchiveBytes) {
              response.destroy()
              failure('archive_size_mismatch')
            }
            await writeAll(output, chunk, bytesWritten - chunk.byteLength)
            hash.update(chunk)
          }
          await output.sync()
        } finally {
          await output.close()
        }
        if (bytesWritten !== descriptor.archiveBytes) failure('archive_size_mismatch')
        if (hash.digest('hex') !== descriptor.archiveSha256) failure('archive_hash_mismatch')
        return
      }
    } catch (error) {
      if (error instanceof ConverterPackError) throw error
      failure('download_failed')
    }
  }

  async cleanup(input: CleanupConverterPacksInput = {}): Promise<void> {
    await this.initialize()
    await this.withLifecycleLock(() => this.cleanupLocked(input))
  }

  private async cleanupLocked(input: CleanupConverterPacksInput): Promise<void> {
    const protectedVersions = new Set<string>(this.activeLeases.keys())
    for (const reference of [...(input.currentVersions ?? []), ...(input.jobReferences ?? [])]) {
      protectedVersions.add(exactReferenceKey(reference))
    }
    for (const [family, version] of this.currentVersions) {
      const [name, platform, arch] = family.split('\0')
      if (name && platform && arch) protectedVersions.add(`${name}\0${version}\0${platform}\0${arch}`)
    }

    if (!approvedConverterPackTarget(this.platform, this.arch)) failure('platform_unsupported')
    const target: { platform: ConverterPackPlatform; arch: ConverterPackArchitecture } = {
      platform: this.platform as ConverterPackPlatform,
      arch: this.arch as ConverterPackArchitecture,
    }
    const root = this.root()
    for (const packEntry of await readdir(root, { withFileTypes: true })) {
      if (!packEntry.isDirectory() || !(CONVERTER_PACK_NAMES as readonly string[]).includes(packEntry.name)) continue
      const packRoot = join(root, packEntry.name)
      const versions: Array<{ version: string; path: string; key: string }> = []
      for (const versionEntry of await readdir(packRoot, { withFileTypes: true })) {
        if (!versionEntry.isDirectory() || !isConverterPackVersion(versionEntry.name)) continue
        const path = join(packRoot, versionEntry.name, `${target.platform}-${target.arch}`)
        try {
          const metadata = await lstat(path)
          if (metadata.isSymbolicLink() || !metadata.isDirectory()) continue
          versions.push({
            version: versionEntry.name,
            path,
            key: exactReferenceKey({
              name: packEntry.name as ConverterPackName,
              version: versionEntry.name,
              platform: target.platform,
              arch: target.arch,
            }),
          })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      const current = this.currentVersions.get(familyKey({
        name: packEntry.name as ConverterPackName,
        platform: target.platform,
        arch: target.arch,
      }))
      if (!current) continue
      const previous = versions
        .filter((candidate) => candidate.version !== current)
        .sort((left, right) => compareSemanticVersions(right.version, left.version))[0]
      if (previous) protectedVersions.add(previous.key)
      for (const candidate of versions) {
        if (protectedVersions.has(candidate.key) || !await safeTreeForRemoval(root, candidate.path)) continue
        await rm(candidate.path, { recursive: true, force: false })
        try {
          await rmdir(dirname(candidate.path))
        } catch (error) {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        }
      }
    }
  }
}
