import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import { isIP, type Socket } from 'node:net'
import { toSafeAppError, type AppError } from '@autoforge/shared'

export const MAX_SAFE_DOWNLOAD_BYTES = 500 * 1024 * 1024

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 15_000
const DEFAULT_TOTAL_TIMEOUT_MS = 120_000
const MAX_TIMER_MS = 0x7fff_ffff
const MAX_REDIRECTS = 3
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const CONTENT_TYPE_PATTERN = /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/i

type TimerHandle = unknown
type PinnedLookup = NonNullable<RequestOptions['lookup']>

export interface SafeDownloadOptions {
  maxBytes: number
  maxRedirects?: number
  connectTimeoutMs?: number
  firstByteTimeoutMs?: number
  totalTimeoutMs?: number
}

export interface SafeDownloadResult {
  byteSize: number
  contentType?: string
}

export interface SafeMediaDownloaderDependencies {
  resolveHost(hostname: string): Promise<readonly LookupAddress[]>
  request(
    url: URL,
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ): ClientRequest
  setTimer(callback: () => void, milliseconds: number): TimerHandle
  clearTimer(handle: TimerHandle): void
}

interface ValidatedOptions {
  maxBytes: number
  maxRedirects: number
  connectTimeoutMs: number
  firstByteTimeoutMs: number
  totalTimeoutMs: number
}

interface DownloadContext {
  aborted: boolean
  abortCurrent?: () => void
}

interface RedirectResult {
  kind: 'redirect'
  location: string
}

interface BodyResult extends SafeDownloadResult {
  kind: 'body'
}

type RequestResult = RedirectResult | BodyResult

interface LookupOptionsLike {
  all?: boolean
  family?: number | string
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address?: string | readonly LookupAddress[],
  family?: number,
) => void

function failure(): AppError {
  return toSafeAppError({ code: 'MEDIA_DOWNLOAD_FAILED' })
}

function defaultResolveHost(hostname: string): Promise<readonly LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) reject(error)
      else resolve(addresses)
    })
  })
}

function positiveInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= maximum
}

function unsafeUrlText(value: string): boolean {
  return value.includes('\\') || [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x20 || code === 0x7f
  })
}

function validatedOptions(options: SafeDownloadOptions): ValidatedOptions {
  if (
    typeof options !== 'object'
    || options === null
    || !positiveInteger(options.maxBytes, MAX_SAFE_DOWNLOAD_BYTES)
  ) throw failure()

  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const firstByteTimeoutMs = options.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS
  if (
    !Number.isSafeInteger(maxRedirects)
    || maxRedirects < 0
    || maxRedirects > MAX_REDIRECTS
    || !positiveInteger(connectTimeoutMs, MAX_TIMER_MS)
    || !positiveInteger(firstByteTimeoutMs, MAX_TIMER_MS)
    || !positiveInteger(totalTimeoutMs, MAX_TIMER_MS)
  ) throw failure()

  return {
    maxBytes: options.maxBytes,
    maxRedirects,
    connectTimeoutMs,
    firstByteTimeoutMs,
    totalTimeoutMs,
  }
}

function canonicalUrl(rawUrl: string): URL {
  if (
    typeof rawUrl !== 'string'
    || rawUrl.length === 0
    || rawUrl !== rawUrl.trim()
    || unsafeUrlText(rawUrl)
    || !rawUrl.startsWith('https://')
  ) throw failure()

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw failure()
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.port !== ''
    || parsed.hash !== ''
  ) throw failure()

  const authority = rawUrl.slice('https://'.length).split(/[/?#]/u, 1)[0]
  if (!authority || authority !== parsed.host || authority.includes('%') || authority.includes('@')) {
    throw failure()
  }

  const hostname = bareHostname(parsed)
  if (hostname.endsWith('.') || hostname.includes('%')) throw failure()
  const addressFamily = isIP(hostname)
  if (addressFamily === 0) {
    const labels = hostname.split('.')
    if (
      hostname.length > 253
      || labels.length < 2
      || labels.some((label) => (
        label.length === 0
        || label.length > 63
        || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
      ))
    ) throw failure()
  }
  return parsed
}

function redirectUrl(location: string, base: URL): URL {
  if (
    typeof location !== 'string'
    || location.length === 0
    || location !== location.trim()
    || unsafeUrlText(location)
    || location.startsWith('//')
  ) throw failure()
  if (/^[a-z][a-z0-9+.-]*:/iu.test(location)) return canonicalUrl(location)

  let resolved: URL
  try {
    resolved = new URL(location, base)
  } catch {
    throw failure()
  }
  return canonicalUrl(resolved.href)
}

function bareHostname(url: URL): string {
  return url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname
}

function parseIpv4(address: string): readonly number[] | undefined {
  if (isIP(address) !== 4) return undefined
  const octets = address.split('.').map(Number)
  return octets.length === 4 ? octets : undefined
}

function prohibitedIpv4(address: string): boolean {
  const octets = parseIpv4(address)
  if (!octets) return true
  const [first, second, third] = octets as [number, number, number, number]
  return (
    first === 0
    || first === 10
    || (first === 100 && second >= 64 && second <= 127)
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0 && third === 0)
    || (first === 192 && second === 0 && third === 2)
    || (first === 192 && second === 31 && third === 196)
    || (first === 192 && second === 52 && third === 193)
    || (first === 192 && second === 88 && third === 99)
    || (first === 192 && second === 168)
    || (first === 192 && second === 175 && third === 48)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113)
    || first >= 224
  )
}

function ipv6Bytes(address: string): Uint8Array | undefined {
  if (isIP(address) !== 6 || address.includes('%')) return undefined
  let normalized = address.toLowerCase()
  const ipv4Tail = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/u)?.[1]
  if (ipv4Tail) {
    const octets = parseIpv4(ipv4Tail)
    if (!octets) return undefined
    const replacement = `${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`
    normalized = normalized.slice(0, -ipv4Tail.length) + replacement
  }

  const halves = normalized.split('::')
  if (halves.length > 2) return undefined
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined
  const words = [
    ...left,
    ...Array.from({ length: missing }, () => '0'),
    ...right,
  ].map((part) => Number.parseInt(part, 16))
  if (words.length !== 8 || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) {
    return undefined
  }

  const bytes = new Uint8Array(16)
  words.forEach((word, index) => {
    bytes[index * 2] = word >> 8
    bytes[index * 2 + 1] = word & 0xff
  })
  return bytes
}

function matchesPrefix(bytes: Uint8Array, prefix: readonly number[], bits: number): boolean {
  const fullBytes = Math.floor(bits / 8)
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== prefix[index]) return false
  }
  const remaining = bits % 8
  if (remaining === 0) return true
  const mask = 0xff << (8 - remaining)
  return (bytes[fullBytes]! & mask) === (prefix[fullBytes]! & mask)
}

function prohibitedIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address)
  if (!bytes) return true
  return (
    !matchesPrefix(bytes, [0x20], 3)
    || matchesPrefix(bytes, [0x00], 8)
    || matchesPrefix(bytes, [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], 64)
    || matchesPrefix(bytes, [0x20, 0x01, 0x00], 23)
    || matchesPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)
    || matchesPrefix(bytes, [0x20, 0x02], 16)
    || matchesPrefix(bytes, [0x26, 0x20, 0x00, 0x4f, 0x80, 0x00], 48)
    || matchesPrefix(bytes, [0x3f, 0xff, 0x00], 20)
    || matchesPrefix(bytes, [0x5f, 0x00], 16)
    || matchesPrefix(bytes, [0xfc], 7)
    || matchesPrefix(bytes, [0xfe, 0x80], 10)
    || matchesPrefix(bytes, [0xfe, 0xc0], 10)
    || matchesPrefix(bytes, [0xff], 8)
  )
}

function publicAddresses(addresses: readonly LookupAddress[]): readonly LookupAddress[] {
  if (addresses.length === 0) throw failure()
  const validated: LookupAddress[] = []
  for (const answer of addresses) {
    if (
      typeof answer !== 'object'
      || answer === null
      || (answer.family !== 4 && answer.family !== 6)
      || isIP(answer.address) !== answer.family
      || (answer.family === 4 ? prohibitedIpv4(answer.address) : prohibitedIpv6(answer.address))
    ) throw failure()
    validated.push({ address: answer.address, family: answer.family })
  }
  return validated
}

function unavailableAddress(): NodeJS.ErrnoException {
  return Object.assign(new Error('Address unavailable'), { code: 'ENOTFOUND' })
}

function pinnedLookup(hostname: string, addresses: readonly LookupAddress[]): PinnedLookup {
  const lookup = (
    requestedHostname: string,
    options: LookupOptionsLike | number,
    callback: LookupCallback,
  ): void => {
    if (requestedHostname !== hostname) {
      callback(unavailableAddress())
      return
    }
    const lookupOptions = typeof options === 'number' ? { family: options } : options
    const family = lookupOptions.family === 4 || lookupOptions.family === 'IPv4'
      ? 4
      : lookupOptions.family === 6 || lookupOptions.family === 'IPv6' ? 6 : 0
    const eligible = family === 0 ? addresses : addresses.filter((answer) => answer.family === family)
    if (eligible.length === 0) {
      callback(unavailableAddress())
      return
    }
    if (lookupOptions.all) callback(null, eligible)
    else callback(null, eligible[0]!.address, eligible[0]!.family)
  }
  return lookup as PinnedLookup
}

function normalizedContentType(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const mediaType = value.split(';', 1)[0]!.trim().toLowerCase()
  return CONTENT_TYPE_PATTERN.test(mediaType) ? mediaType : undefined
}

function contentLength(value: string | string[] | undefined): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) throw failure()
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw failure()
  return parsed
}

/**
 * Downloads HTTPS media into a caller-owned destination.
 *
 * The destination is never ended or destroyed. If a download fails after bytes
 * were written, those partial bytes remain and the caller owns their cleanup.
 */
export class SafeMediaDownloader {
  private readonly dependencies: SafeMediaDownloaderDependencies

  constructor(dependencies: Partial<SafeMediaDownloaderDependencies> = {}) {
    this.dependencies = {
      resolveHost: defaultResolveHost,
      request: (url, options, callback) => httpsRequest(url, options, callback),
      setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      ...dependencies,
    }
  }

  async download(
    rawUrl: string,
    destination: NodeJS.WritableStream,
    options: SafeDownloadOptions,
  ): Promise<SafeDownloadResult> {
    let validated: ValidatedOptions
    let initialUrl: URL
    try {
      validated = validatedOptions(options)
      initialUrl = canonicalUrl(rawUrl)
      if (
        !destination
        || typeof destination.write !== 'function'
        || typeof destination.on !== 'function'
        || typeof destination.removeListener !== 'function'
        || (destination as { destroyed?: unknown }).destroyed === true
        || (destination as { writableEnded?: unknown }).writableEnded === true
      ) throw failure()
    } catch {
      throw failure()
    }

    return new Promise<SafeDownloadResult>((resolve, reject) => {
      const context: DownloadContext = { aborted: false }
      let settled = false
      let totalTimer: TimerHandle | undefined

      const cleanup = () => {
        if (totalTimer !== undefined) this.dependencies.clearTimer(totalTimer)
        totalTimer = undefined
        destination.removeListener('error', onDestinationError)
        destination.removeListener('close', onDestinationClose)
      }
      const fail = () => {
        if (settled) return
        settled = true
        context.aborted = true
        context.abortCurrent?.()
        cleanup()
        reject(failure())
      }
      const succeed = (result: SafeDownloadResult) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      }
      const onDestinationError = () => fail()
      const onDestinationClose = () => fail()

      destination.on('error', onDestinationError)
      destination.on('close', onDestinationClose)
      totalTimer = this.dependencies.setTimer(fail, validated.totalTimeoutMs)
      void this.downloadValidated(initialUrl, destination, validated, context).then(succeed, fail)
    })
  }

  private async downloadValidated(
    initialUrl: URL,
    destination: NodeJS.WritableStream,
    options: ValidatedOptions,
    context: DownloadContext,
  ): Promise<SafeDownloadResult> {
    let currentUrl = initialUrl
    let redirectCount = 0
    while (true) {
      if (context.aborted) throw failure()
      const hostname = bareHostname(currentUrl)
      let addresses: readonly LookupAddress[]
      try {
        addresses = isIP(hostname) === 0
          ? publicAddresses(await this.dependencies.resolveHost(hostname))
          : publicAddresses([{ address: hostname, family: isIP(hostname) as 4 | 6 }])
      } catch {
        throw failure()
      }
      if (context.aborted) throw failure()

      const result = await this.requestOnce(currentUrl, hostname, addresses, destination, options, context)
      if (result.kind === 'body') {
        return {
          byteSize: result.byteSize,
          ...(result.contentType ? { contentType: result.contentType } : {}),
        }
      }
      if (redirectCount >= options.maxRedirects) throw failure()
      currentUrl = redirectUrl(result.location, currentUrl)
      redirectCount += 1
    }
  }

  private requestOnce(
    url: URL,
    hostname: string,
    addresses: readonly LookupAddress[],
    destination: NodeJS.WritableStream,
    options: ValidatedOptions,
    context: DownloadContext,
  ): Promise<RequestResult> {
    return new Promise<RequestResult>((resolve, reject) => {
      let request: ClientRequest
      let socket: Socket | undefined
      let response: IncomingMessage | undefined
      let connectTimer: TimerHandle | undefined
      let firstByteTimer: TimerHandle | undefined
      let settled = false
      let responseEnded = false
      let waitingForDrain = false
      let byteSize = 0
      let pendingWrites = 0
      let responseContentType: string | undefined

      const clearConnectTimer = () => {
        if (connectTimer !== undefined) this.dependencies.clearTimer(connectTimer)
        connectTimer = undefined
      }
      const clearFirstByteTimer = () => {
        if (firstByteTimer !== undefined) this.dependencies.clearTimer(firstByteTimer)
        firstByteTimer = undefined
      }
      const cleanup = () => {
        clearConnectTimer()
        clearFirstByteTimer()
        request.removeListener('socket', onSocket)
        request.removeListener('error', onRequestError)
        socket?.removeListener('secureConnect', onConnected)
        socket?.removeListener('error', onSocketError)
        if (response) {
          response.removeListener('data', onData)
          response.removeListener('end', onEnd)
          response.removeListener('error', onResponseError)
          response.removeListener('aborted', onResponseAborted)
          response.removeListener('close', onResponseClose)
        }
        destination.removeListener('drain', onDrain)
        context.abortCurrent = undefined
      }
      const cancelOwnedStreams = () => {
        if (response && !response.destroyed) response.destroy()
        if (!request.destroyed) request.destroy()
      }
      const fail = () => {
        if (settled) return
        settled = true
        cleanup()
        cancelOwnedStreams()
        reject(failure())
      }
      const succeed = (result: RequestResult) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      }
      const cancelResponse = () => {
        if (response && !response.destroyed) response.destroy()
      }
      const onConnected = () => {
        if (settled) return
        clearConnectTimer()
        if (firstByteTimer === undefined) {
          firstByteTimer = this.dependencies.setTimer(fail, options.firstByteTimeoutMs)
        }
      }
      const onSocket = (connectedSocket: Socket) => {
        socket = connectedSocket
        socket.on('secureConnect', onConnected)
        socket.on('error', onSocketError)
        if (!socket.connecting) onConnected()
      }
      const onRequestError = () => fail()
      const onSocketError = () => fail()
      const onResponseError = () => fail()
      const onResponseAborted = () => fail()
      const onResponseClose = () => {
        if (!responseEnded) fail()
      }
      const completeBody = () => {
        if (!responseEnded || pendingWrites !== 0 || waitingForDrain) return
        succeed({
          kind: 'body',
          byteSize,
          ...(responseContentType ? { contentType: responseContentType } : {}),
        })
      }
      const onDrain = () => {
        if (settled || !waitingForDrain) return
        waitingForDrain = false
        destination.removeListener('drain', onDrain)
        if (responseEnded) {
          completeBody()
        } else {
          response?.resume()
        }
      }
      const onData = (chunk: Buffer | string) => {
        if (settled) return
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (bytes.byteLength > options.maxBytes - byteSize) {
          fail()
          return
        }
        byteSize += bytes.byteLength
        pendingWrites += 1
        try {
          const accepted = destination.write(bytes, (error?: Error | null) => {
            if (settled) return
            pendingWrites -= 1
            // Node Writable emits the same asynchronous write error. Keep the
            // destination error listener installed until that event arrives.
            if (!error) completeBody()
          })
          if (accepted === false) {
            waitingForDrain = true
            response?.pause()
            destination.on('drain', onDrain)
          }
        } catch {
          pendingWrites -= 1
          fail()
        }
      }
      const onEnd = () => {
        responseEnded = true
        completeBody()
      }
      const onResponse = (incoming: IncomingMessage) => {
        if (settled) {
          incoming.destroy()
          return
        }
        response = incoming
        clearConnectTimer()
        clearFirstByteTimer()
        const statusCode = response.statusCode
        if (!Number.isInteger(statusCode)) {
          cancelResponse()
          fail()
          return
        }
        if (REDIRECT_STATUSES.has(statusCode!)) {
          const location = response.headers.location
          cancelResponse()
          if (typeof location !== 'string') fail()
          else succeed({ kind: 'redirect', location })
          return
        }
        if (statusCode! < 200 || statusCode! > 299) {
          cancelResponse()
          fail()
          return
        }

        let declaredLength: number | undefined
        try {
          declaredLength = contentLength(response.headers['content-length'])
        } catch {
          cancelResponse()
          fail()
          return
        }
        if (declaredLength !== undefined && declaredLength > options.maxBytes) {
          cancelResponse()
          fail()
          return
        }
        responseContentType = normalizedContentType(response.headers['content-type'])
        response.on('data', onData)
        response.on('end', onEnd)
        response.on('error', onResponseError)
        response.on('aborted', onResponseAborted)
        response.on('close', onResponseClose)
      }

      try {
        request = this.dependencies.request(url, {
          agent: false,
          lookup: pinnedLookup(hostname, addresses),
          method: 'GET',
        }, onResponse)
      } catch {
        reject(failure())
        return
      }
      context.abortCurrent = fail
      request.on('socket', onSocket)
      request.on('error', onRequestError)
      connectTimer = this.dependencies.setTimer(fail, options.connectTimeoutMs)
      try {
        request.end()
      } catch {
        fail()
      }
    })
  }
}
