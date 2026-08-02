import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { isIP } from 'node:net'
import { toSafeAppError, type AppError, type ProxySettings } from '@autoforge/shared'
import type { NetworkTransportSnapshot } from '../network/network-proxy-service.js'
import { selectMediaRoute, validatedPublicAddresses, type MediaRouteSelection } from './media-route.js'
import {
  PinnedMediaTransport,
  type PinnedMediaTransportPort,
  type SafeMediaResponse,
} from './pinned-media-transport.js'

export const MAX_SAFE_DOWNLOAD_BYTES = 500 * 1024 * 1024

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 15_000
const DEFAULT_TOTAL_TIMEOUT_MS = 120_000
const MAX_TIMER_MS = 0x7fff_ffff
const MAX_REDIRECTS = 3
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const CONTENT_TYPE_PATTERN = /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/i

type TimerHandle = unknown

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
  transport: PinnedMediaTransportPort
  withTransportLease<T>(
    operation: (snapshot: NetworkTransportSnapshot) => Promise<T>,
  ): Promise<T>
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
  abortCurrent?: () => Promise<void>
}

interface RedirectResult {
  kind: 'redirect'
  location: string
}

interface BodyResult extends SafeDownloadResult {
  kind: 'body'
}

type RequestResult = RedirectResult | BodyResult

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

function normalizedContentType(value: string | null): string | undefined {
  if (typeof value !== 'string') return undefined
  const mediaType = value.split(';', 1)[0]!.trim().toLowerCase()
  return CONTENT_TYPE_PATTERN.test(mediaType) ? mediaType : undefined
}

function contentLength(value: string | null): number | undefined {
  if (value === null) return undefined
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw failure()
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw failure()
  return parsed
}

function rawHeaderValues(rawHeaders: readonly string[], name: string): string[] {
  if (rawHeaders.length % 2 !== 0) throw failure()
  const values: string[] = []
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const key = rawHeaders[index]
    const value = rawHeaders[index + 1]
    if (typeof key !== 'string' || typeof value !== 'string') throw failure()
    if (key.toLowerCase() === name) values.push(value)
  }
  return values
}

function singleRawHeader(rawHeaders: readonly string[], name: string): string | null {
  const values = rawHeaderValues(rawHeaders, name)
  if (values.length > 1) throw failure()
  return values[0] ?? null
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
      transport: new PinnedMediaTransport(),
      withTransportLease: async (operation) => operation({
        settings: Object.freeze({
          enabled: false,
          bypassDomains: Object.freeze([] as string[]) as string[],
        }),
      }),
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
      let failureCleanup: Promise<void> | undefined

      const cleanup = () => {
        if (totalTimer !== undefined) this.dependencies.clearTimer(totalTimer)
        totalTimer = undefined
        destination.removeListener('error', onDestinationError)
        destination.removeListener('close', onDestinationClose)
      }
      const fail = (): Promise<void> => {
        if (settled) return failureCleanup ?? Promise.resolve()
        settled = true
        context.aborted = true
        const abortCurrent = context.abortCurrent
        cleanup()
        failureCleanup = (async () => {
          try { await abortCurrent?.() } finally { reject(failure()) }
        })()
        return failureCleanup
      }
      const succeed = (result: SafeDownloadResult) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      }
      const onDestinationError = () => { void fail() }
      const onDestinationClose = () => { void fail() }

      destination.on('error', onDestinationError)
      destination.on('close', onDestinationClose)
      totalTimer = this.dependencies.setTimer(() => { void fail() }, validated.totalTimeoutMs)
      void this.dependencies.withTransportLease(async ({ settings }) => {
        if (context.aborted) throw failure()
        return this.downloadValidated(
          initialUrl,
          destination,
          validated,
          context,
          settings,
        )
      }).then(succeed, fail)
    })
  }

  private async downloadValidated(
    initialUrl: URL,
    destination: NodeJS.WritableStream,
    options: ValidatedOptions,
    context: DownloadContext,
    settings: ProxySettings,
  ): Promise<SafeDownloadResult> {
    let currentUrl = initialUrl
    let redirectCount = 0
    while (true) {
      if (context.aborted) throw failure()
      const hostname = bareHostname(currentUrl)
      let addresses: readonly LookupAddress[]
      try {
        addresses = isIP(hostname) === 0
          ? validatedPublicAddresses(await this.dependencies.resolveHost(hostname))
          : validatedPublicAddresses([{
              address: hostname,
              family: isIP(hostname) as 4 | 6,
            }])
      } catch {
        throw failure()
      }
      if (context.aborted) throw failure()

      let selection: MediaRouteSelection
      try {
        selection = selectMediaRoute(settings, hostname, addresses)
      } catch {
        throw failure()
      }
      const result = await this.requestOnce(
        currentUrl,
        selection,
        destination,
        options,
        context,
      )
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
    selection: MediaRouteSelection,
    destination: NodeJS.WritableStream,
    options: ValidatedOptions,
    context: DownloadContext,
  ): Promise<RequestResult> {
    return new Promise<RequestResult>((resolve, reject) => {
      const controller = new AbortController()
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let cancelResponse: SafeMediaResponse['cancel'] | undefined
      let responseClosed: Promise<void> | undefined
      let pendingTransportRequest: Promise<SafeMediaResponse> | undefined
      let connectTimer: TimerHandle | undefined
      let firstByteTimer: TimerHandle | undefined
      let settled = false
      let settlement: Promise<void> | undefined
      let streamClosure: Promise<void> | undefined
      let bodyEnded = false
      let waitingForDrain = false
      let byteSize = 0
      let pendingWrites = 0
      let resumeAfterDrain: (() => void) | undefined
      let destinationWriteGuardInstalled = false
      let writeCallbackErrorObserved = false
      let writeErrorEventObserved = false
      let declaredContentLength: number | undefined
      let responseContentType: string | undefined

      const releaseDestinationWriteGuardIfSettled = () => {
        if (
          !destinationWriteGuardInstalled
          || pendingWrites !== 0
          || (writeCallbackErrorObserved && !writeErrorEventObserved)
        ) return
        destination.removeListener('error', onPendingDestinationError)
        destinationWriteGuardInstalled = false
        writeCallbackErrorObserved = false
        writeErrorEventObserved = false
      }
      const retainDestinationWriteGuard = () => {
        if (destinationWriteGuardInstalled) return
        destinationWriteGuardInstalled = true
        writeCallbackErrorObserved = false
        writeErrorEventObserved = false
        destination.on('error', onPendingDestinationError)
      }
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
        destination.removeListener('drain', onDrain)
        waitingForDrain = false
        resumeAfterDrain?.()
        resumeAfterDrain = undefined
        releaseDestinationWriteGuardIfSettled()
      }
      const releaseAbortCurrent = () => {
        if (context.abortCurrent === fail) context.abortCurrent = undefined
      }
      const captureResponse = (response: SafeMediaResponse): void => {
        if (typeof response.cancel === 'function') cancelResponse = response.cancel.bind(response)
        if (
          response.closed
          && typeof response.closed === 'object'
          && typeof response.closed.then === 'function'
        ) responseClosed = Promise.resolve(response.closed)
      }
      const awaitResponseClosed = async (): Promise<void> => {
        try { await responseClosed } catch { /* Teardown errors stay inside the downloader boundary. */ }
      }
      const cancelOwnedStreams = (): Promise<void> => {
        streamClosure ??= (async () => {
          controller.abort()
          const pending = pendingTransportRequest
          if (pending && !cancelResponse) {
            try { captureResponse(await pending) } catch { /* Request rejection owns pre-header teardown. */ }
          }
          const cancel = cancelResponse
          if (cancel) {
            try { await cancel(failure()) } catch { /* Teardown errors stay inside the downloader boundary. */ }
          }
          await awaitResponseClosed()
        })()
        return streamClosure
      }
      const fail = (): Promise<void> => {
        if (settled) {
          if (settlement) void cancelOwnedStreams()
          return settlement ?? Promise.resolve()
        }
        settled = true
        cleanup()
        settlement = cancelOwnedStreams().then(() => {
          releaseAbortCurrent()
          reject(failure())
        })
        return settlement
      }
      const succeed = (result: RequestResult) => {
        if (settled) return
        settled = true
        cleanup()
        settlement = awaitResponseClosed().then(() => {
          releaseAbortCurrent()
          resolve(result)
        })
      }
      function onPendingDestinationError(): void {
        writeErrorEventObserved = true
        fail()
        releaseDestinationWriteGuardIfSettled()
      }
      const completeBody = () => {
        if (!bodyEnded || pendingWrites !== 0 || waitingForDrain) return
        if (declaredContentLength !== undefined && byteSize !== declaredContentLength) {
          fail()
          return
        }
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
        const resume = resumeAfterDrain
        resumeAfterDrain = undefined
        resume?.()
        completeBody()
      }
      const writeChunk = (chunk: Uint8Array): Promise<void> | undefined => {
        if (settled) return undefined
        const bytes = Buffer.from(chunk)
        if (
          bytes.byteLength > options.maxBytes - byteSize
          || (
            declaredContentLength !== undefined
            && bytes.byteLength > declaredContentLength - byteSize
          )
        ) {
          fail()
          return undefined
        }
        byteSize += bytes.byteLength
        pendingWrites += 1
        retainDestinationWriteGuard()
        try {
          const accepted = destination.write(bytes, (error?: Error | null) => {
            pendingWrites -= 1
            if (error) {
              writeCallbackErrorObserved = true
              fail()
            } else if (!settled) {
              completeBody()
            }
            releaseDestinationWriteGuardIfSettled()
          })
          if (accepted === false) {
            waitingForDrain = true
            destination.on('drain', onDrain)
            return new Promise<void>((resolveDrain) => { resumeAfterDrain = resolveDrain })
          }
        } catch {
          pendingWrites -= 1
          fail()
          releaseDestinationWriteGuardIfSettled()
        }
        return undefined
      }
      context.abortCurrent = fail
      connectTimer = this.dependencies.setTimer(() => { void fail() }, options.connectTimeoutMs)
      void (async () => {
        let response: SafeMediaResponse | undefined
        for (const candidate of selection.destinationAddresses) {
          try {
            const transportRequest = this.dependencies.transport.request({
              url,
              destinationAddress: candidate.address,
              route: selection.route,
              signal: controller.signal,
            })
            pendingTransportRequest = transportRequest
            response = await transportRequest
            captureResponse(response)
            if (pendingTransportRequest === transportRequest) pendingTransportRequest = undefined
            break
          } catch {
            pendingTransportRequest = undefined
            if (controller.signal.aborted || context.aborted) {
              await fail()
              return
            }
          }
        }
        if (!response) {
          fail()
          return
        }
        clearConnectTimer()
        if (settled || context.aborted) {
          await cancelOwnedStreams()
          return
        }
        if (
          !Number.isInteger(response.statusCode)
          || !Array.isArray(response.rawHeaders)
          || typeof response.cancel !== 'function'
          || !response.closed
          || typeof response.closed !== 'object'
          || typeof response.closed.then !== 'function'
        ) {
          fail()
          return
        }

        const body = response.body
        if (!body || typeof body.getReader !== 'function') {
          fail()
          return
        }
        try {
          reader = body.getReader()
        } catch {
          fail()
          return
        }

        if (REDIRECT_STATUSES.has(response.statusCode)) {
          let location: string | null
          try {
            location = singleRawHeader(response.rawHeaders, 'location')
          } catch {
            fail()
            return
          }
          await cancelOwnedStreams()
          if (location === null) fail()
          else succeed({ kind: 'redirect', location })
          return
        }
        if (response.statusCode < 200 || response.statusCode > 299) {
          fail()
          return
        }

        try {
          declaredContentLength = contentLength(singleRawHeader(
            response.rawHeaders,
            'content-length',
          ))
          responseContentType = normalizedContentType(singleRawHeader(
            response.rawHeaders,
            'content-type',
          ))
        } catch {
          fail()
          return
        }
        if (declaredContentLength !== undefined && declaredContentLength > options.maxBytes) {
          fail()
          return
        }
        firstByteTimer = this.dependencies.setTimer(() => { void fail() }, options.firstByteTimeoutMs)

        while (!settled) {
          let result: ReadableStreamReadResult<Uint8Array>
          try {
            result = await reader.read()
          } catch {
            fail()
            return
          }
          if (settled) return
          if (result.done) {
            clearFirstByteTimer()
            bodyEnded = true
            completeBody()
            return
          }
          clearFirstByteTimer()
          if (!(result.value instanceof Uint8Array)) {
            fail()
            return
          }
          const backpressure = writeChunk(result.value)
          if (backpressure) await backpressure
        }
      })()
    })
  }
}
