import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { isIP } from 'node:net'
import { toSafeAppError, type AppError } from '@autoforge/shared'
import { validatedPublicAddresses } from './media-route.js'

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
  fetch(input: string, init: RequestInit): Promise<Response>
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
      fetch: (input, init) => globalThis.fetch(input, init),
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
      try {
        if (isIP(hostname) === 0) validatedPublicAddresses(await this.dependencies.resolveHost(hostname))
        else validatedPublicAddresses([{ address: hostname, family: isIP(hostname) as 4 | 6 }])
      } catch {
        throw failure()
      }
      if (context.aborted) throw failure()

      const result = await this.requestOnce(currentUrl, destination, options, context)
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
    destination: NodeJS.WritableStream,
    options: ValidatedOptions,
    context: DownloadContext,
  ): Promise<RequestResult> {
    return new Promise<RequestResult>((resolve, reject) => {
      const controller = new AbortController()
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let responseBody: Response['body']
      let connectTimer: TimerHandle | undefined
      let firstByteTimer: TimerHandle | undefined
      let settled = false
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
        context.abortCurrent = undefined
      }
      const cancelOwnedStreams = () => {
        controller.abort()
        if (reader) void reader.cancel(failure()).catch(() => undefined)
        else if (responseBody && typeof responseBody.cancel === 'function') {
          void responseBody.cancel(failure()).catch(() => undefined)
        }
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
      connectTimer = this.dependencies.setTimer(fail, options.connectTimeoutMs)
      void (async () => {
        let response: Response
        try {
          response = await this.dependencies.fetch(url.href, {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
          })
        } catch {
          fail()
          return
        }
        clearConnectTimer()
        if (settled || context.aborted) {
          if (response.body) void response.body.cancel(failure()).catch(() => undefined)
          return
        }
        responseBody = response.body
        if (
          !Number.isInteger(response.status)
          || !response.headers
          || typeof response.headers.get !== 'function'
        ) {
          fail()
          return
        }

        const body = responseBody
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

        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers.get('location')
          try { await reader.cancel(failure()) } catch { /* Lease release is owned by the managed fetch wrapper. */ }
          if (typeof location !== 'string') fail()
          else succeed({ kind: 'redirect', location })
          return
        }
        if (response.status < 200 || response.status > 299) {
          fail()
          return
        }

        try {
          declaredContentLength = contentLength(response.headers.get('content-length'))
        } catch {
          fail()
          return
        }
        if (declaredContentLength !== undefined && declaredContentLength > options.maxBytes) {
          fail()
          return
        }
        responseContentType = normalizedContentType(response.headers.get('content-type'))
        firstByteTimer = this.dependencies.setTimer(fail, options.firstByteTimeoutMs)

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
