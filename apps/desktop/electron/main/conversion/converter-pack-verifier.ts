import { createPublicKey, verify as verifySignature } from 'node:crypto'
import { isAbsolute, posix } from 'node:path'
import {
  CONVERTER_PACK_NAMES,
  ConverterPackError,
  type ConverterPackArchitecture,
  type ConverterPackDescriptor,
  type ConverterPackIndex,
  type ConverterPackName,
  type ConverterPackPlatform,
} from './converter-pack-types.js'

export interface ConverterPackVerificationLimits {
  maxArchiveBytes: number
  maxEntries: number
  maxEntryBytes: number
  maxExpandedBytes: number
}

export const DEFAULT_CONVERTER_PACK_LIMITS: Readonly<ConverterPackVerificationLimits> = Object.freeze({
  maxArchiveBytes: 512 * 1024 * 1024,
  maxEntries: 256,
  maxEntryBytes: 1024 * 1024 * 1024,
  maxExpandedBytes: 2 * 1024 * 1024 * 1024,
})

interface VerifyConverterPackIndexInput {
  index: unknown
  signature: string | Uint8Array
  rootPublicKeyPem: string | Buffer | undefined
  minimumSequence: number
  limits?: Partial<ConverterPackVerificationLimits>
}

interface SelectConverterPackInput {
  name: ConverterPackName
  version?: string
  platform: ConverterPackPlatform
  arch: ConverterPackArchitecture
}

const packNames = new Set<string>(CONVERTER_PACK_NAMES)
const sha256Pattern = /^[a-f0-9]{64}$/u
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
const reservedWindowsName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu

function failure(reason: ConstructorParameters<typeof ConverterPackError>[0]): never {
  throw new ConverterPackError(reason)
}

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => (
    descriptor.get === undefined && descriptor.set === undefined
  ))
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) failure('index_invalid')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (!record(value)) failure('index_invalid')
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

export function canonicalConverterPackIndexBytes(index: unknown): Buffer {
  return Buffer.from(canonicalJson(index), 'utf8')
}

function positiveInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= maximum
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function boundedNonNegativeInteger(value: unknown, maximum: number): value is number {
  return nonNegativeInteger(value) && (value as number) <= maximum
}

export function isConverterPackVersion(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 128) return false
  const match = semverPattern.exec(value)
  if (!match) return false
  const prerelease = match[4]
  return prerelease === undefined || prerelease.split('.').every((identifier) => (
    !/^\d+$/u.test(identifier) || identifier === '0' || !identifier.startsWith('0')
  ))
}

export function approvedConverterPackTarget(platform: unknown, arch: unknown): platform is ConverterPackPlatform {
  return (platform === 'darwin' && (arch === 'arm64' || arch === 'x64'))
    || (platform === 'win32' && arch === 'x64')
}

function httpsArchiveUrl(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 2_048
    || value !== value.trim()
    || value.includes('\\')
    || [...value].some((character) => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f)
  ) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:'
      && parsed.username === ''
      && parsed.password === ''
      && parsed.hash === ''
      && parsed.hostname.length > 0
  } catch {
    return false
  }
}

export function safeConverterPackEntryPath(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value, 'utf8') > 240
    || value.includes('\\')
    || value.includes('\0')
    || value.normalize('NFC') !== value
    || value.startsWith('/')
    || value.endsWith('/')
    || isAbsolute(value)
    || posix.normalize(value) !== value
    || value === '..'
    || value.startsWith('../')
  ) return false
  const segments = value.split('/')
  return segments.every((segment) => (
    segment.length > 0
    && segment !== '.'
    && segment !== '..'
    && !segment.endsWith('.')
    && !segment.endsWith(' ')
    && !segment.includes(':')
    && !reservedWindowsName.test(segment)
  ))
}

function verificationLimits(input: Partial<ConverterPackVerificationLimits> | undefined): ConverterPackVerificationLimits {
  const limits = { ...DEFAULT_CONVERTER_PACK_LIMITS, ...input }
  if (
    !positiveInteger(limits.maxArchiveBytes, DEFAULT_CONVERTER_PACK_LIMITS.maxArchiveBytes)
    || !positiveInteger(limits.maxEntries, DEFAULT_CONVERTER_PACK_LIMITS.maxEntries)
    || !positiveInteger(limits.maxEntryBytes, DEFAULT_CONVERTER_PACK_LIMITS.maxEntryBytes)
    || !positiveInteger(limits.maxExpandedBytes, DEFAULT_CONVERTER_PACK_LIMITS.maxExpandedBytes)
  ) failure('index_invalid')
  return limits
}

function validatePack(value: unknown, limits: ConverterPackVerificationLimits): asserts value is ConverterPackDescriptor {
  if (!record(value) || !exactKeys(value, [
    'name', 'version', 'platform', 'arch', 'archiveUrl', 'archiveSha256', 'archiveBytes', 'entries',
  ])) failure('index_invalid')
  if (
    typeof value.name !== 'string'
    || !packNames.has(value.name)
    || !isConverterPackVersion(value.version)
    || !approvedConverterPackTarget(value.platform, value.arch)
    || !httpsArchiveUrl(value.archiveUrl)
    || typeof value.archiveSha256 !== 'string'
    || !sha256Pattern.test(value.archiveSha256)
    || !positiveInteger(value.archiveBytes, limits.maxArchiveBytes)
    || !Array.isArray(value.entries)
    || value.entries.length === 0
    || value.entries.length > limits.maxEntries
  ) failure('index_invalid')

  const paths = new Set<string>()
  let expandedBytes = 0
  for (const entry of value.entries) {
    if (!record(entry) || !exactKeys(entry, ['path', 'sha256', 'bytes', 'executable'])) failure('index_invalid')
    if (
      !safeConverterPackEntryPath(entry.path)
      || typeof entry.sha256 !== 'string'
      || !sha256Pattern.test(entry.sha256)
      || !boundedNonNegativeInteger(entry.bytes, limits.maxEntryBytes)
      || typeof entry.executable !== 'boolean'
    ) failure('index_invalid')
    const collisionKey = entry.path.toLowerCase()
    if (paths.has(collisionKey)) failure('index_invalid')
    paths.add(collisionKey)
    expandedBytes += entry.bytes
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > limits.maxExpandedBytes) failure('index_invalid')
  }
}

function validateIndex(value: unknown, limits: ConverterPackVerificationLimits): asserts value is ConverterPackIndex {
  if (!record(value) || !exactKeys(value, ['schemaVersion', 'generatedAt', 'sequence', 'packs'])) {
    failure('index_invalid')
  }
  if (
    value.schemaVersion !== 1
    || typeof value.generatedAt !== 'string'
    || !nonNegativeInteger(value.sequence)
    || !Array.isArray(value.packs)
    || value.packs.length === 0
    || value.packs.length > 64
  ) failure('index_invalid')
  try {
    if (new Date(value.generatedAt).toISOString() !== value.generatedAt) failure('index_invalid')
  } catch {
    failure('index_invalid')
  }

  const coordinates = new Set<string>()
  for (const pack of value.packs) {
    validatePack(pack, limits)
    const coordinate = `${pack.name}\0${pack.version}\0${pack.platform}\0${pack.arch}`
    if (coordinates.has(coordinate)) failure('index_invalid')
    coordinates.add(coordinate)
  }
}

function detachedSignature(value: string | Uint8Array): Buffer {
  if (typeof value !== 'string') {
    const bytes = Buffer.from(value)
    if (bytes.byteLength !== 64) failure('signature_invalid')
    return bytes
  }
  if (value.length === 0 || value !== value.trim()) failure('signature_invalid')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.byteLength !== 64 || bytes.toString('base64') !== value) failure('signature_invalid')
  return bytes
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

export function verifyConverterPackIndex(input: VerifyConverterPackIndexInput): ConverterPackIndex {
  if (!nonNegativeInteger(input.minimumSequence)) failure('sequence_state_invalid')
  const limits = verificationLimits(input.limits)
  validateIndex(input.index, limits)
  const canonicalBytes = canonicalConverterPackIndexBytes(input.index)
  if (input.rootPublicKeyPem === undefined || input.rootPublicKeyPem.length === 0) failure('root_unavailable')

  let publicKey
  try {
    publicKey = createPublicKey(input.rootPublicKeyPem)
  } catch {
    failure('root_unavailable')
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') failure('root_unavailable')
  if (!verifySignature(null, canonicalBytes, publicKey, detachedSignature(input.signature))) {
    failure('signature_invalid')
  }
  if (input.index.sequence < input.minimumSequence) failure('index_rollback')

  const trustedCopy = JSON.parse(canonicalBytes.toString('utf8')) as unknown
  validateIndex(trustedCopy, limits)
  return deepFreeze(trustedCopy)
}

function compareSemanticVersions(left: string, right: string): number {
  const leftMain = left.split(/[+-]/u, 1)[0]!.split('.')
  const rightMain = right.split(/[+-]/u, 1)[0]!.split('.')
  for (let index = 0; index < 3; index += 1) {
    const leftIdentifier = BigInt(leftMain[index]!)
    const rightIdentifier = BigInt(rightMain[index]!)
    if (leftIdentifier !== rightIdentifier) return leftIdentifier < rightIdentifier ? -1 : 1
  }
  const leftPre = left.includes('-') ? left.slice(left.indexOf('-') + 1).split('+', 1)[0]!.split('.') : undefined
  const rightPre = right.includes('-') ? right.slice(right.indexOf('-') + 1).split('+', 1)[0]!.split('.') : undefined
  if (!leftPre || !rightPre) return leftPre ? -1 : rightPre ? 1 : 0
  for (let index = 0; index < Math.max(leftPre.length, rightPre.length); index += 1) {
    const leftIdentifier = leftPre[index]
    const rightIdentifier = rightPre[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    if (leftIdentifier === rightIdentifier) continue
    const leftNumeric = /^\d+$/u.test(leftIdentifier)
    const rightNumeric = /^\d+$/u.test(rightIdentifier)
    if (leftNumeric && rightNumeric) {
      const leftNumber = BigInt(leftIdentifier)
      const rightNumber = BigInt(rightIdentifier)
      return leftNumber < rightNumber ? -1 : 1
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftIdentifier < rightIdentifier ? -1 : 1
  }
  return 0
}

export function selectConverterPack(
  index: ConverterPackIndex,
  input: SelectConverterPackInput,
): ConverterPackDescriptor {
  if (!approvedConverterPackTarget(input.platform, input.arch)) failure('platform_unsupported')
  if (!packNames.has(input.name) || (input.version !== undefined && !isConverterPackVersion(input.version))) {
    failure('pack_unavailable')
  }
  const candidates = index.packs.filter((pack) => (
    pack.name === input.name
    && pack.platform === input.platform
    && pack.arch === input.arch
    && (input.version === undefined || pack.version === input.version)
  ))
  if (candidates.length === 0) failure('pack_unavailable')
  return candidates.reduce((selected, candidate) => (
    compareSemanticVersions(candidate.version, selected.version) > 0 ? candidate : selected
  ))
}

export { compareSemanticVersions }
