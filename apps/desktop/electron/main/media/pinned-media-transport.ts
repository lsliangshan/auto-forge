import type { Agent, ClientRequest, IncomingMessage } from 'node:http'
import {
  Agent as HttpsAgent,
  request as httpsRequest,
  type RequestOptions,
} from 'node:https'
import { isIP, type Socket } from 'node:net'
import { Readable } from 'node:stream'
import { checkServerIdentity } from 'node:tls'
import { toSafeAppError, type AppError } from '@autoforge/shared'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import type { MediaRoute } from './media-route.js'

export interface PinnedMediaRequest {
  url: URL
  destinationAddress: string
  route: MediaRoute
  signal: AbortSignal
}

export interface SafeMediaResponse {
  statusCode: number
  statusMessage: string
  rawHeaders: readonly string[]
  body: ReadableStream<Uint8Array>
  closed: Promise<void>
  cancel(reason?: unknown): Promise<void>
}

export interface PinnedMediaTransportPort {
  request(input: PinnedMediaRequest): Promise<SafeMediaResponse>
}

interface PinnedMediaTransportDependencies {
  httpsRequest: typeof httpsRequest
  originPort: number
  originCa?: string | Buffer
  proxyCa?: string | Buffer
}

const productionDependencies: PinnedMediaTransportDependencies = {
  httpsRequest,
  originPort: 443,
}

function failure(): AppError {
  return toSafeAppError({ code: 'MEDIA_DOWNLOAD_FAILED' })
}

function bareHostname(url: URL): string {
  return url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname
}

function agentFor(
  route: MediaRoute,
  dependencies: PinnedMediaTransportDependencies,
  signal: AbortSignal,
): Agent {
  if (route.kind === 'direct') return new HttpsAgent({ keepAlive: false })
  if (route.kind === 'http-connect') {
    return new HttpsProxyAgent(route.proxyUrl, {
      keepAlive: true,
      signal,
      ...(dependencies.proxyCa ? { ca: dependencies.proxyCa } : {}),
    })
  }
  if (route.kind === 'socks') {
    return new SocksProxyAgent(route.proxyUrl, {
      keepAlive: true,
      socketOptions: { signal },
    })
  }
  throw failure()
}

function validateInput(input: PinnedMediaRequest): void {
  if (
    typeof input !== 'object'
    || input === null
    || !(input.url instanceof URL)
    || input.url.protocol !== 'https:'
    || input.url.port !== ''
    || input.url.username !== ''
    || input.url.password !== ''
    || isIP(input.destinationAddress) === 0
    || typeof input.route !== 'object'
    || input.route === null
  ) throw failure()

  if (input.route.kind === 'socks' && isIP(input.destinationAddress) === 6) {
    let protocol: string
    try {
      protocol = new URL(input.route.proxyUrl).protocol
    } catch {
      throw failure()
    }
    if (protocol === 'socks4:' || protocol === 'socks4a:') throw failure()
  }
}

export class PinnedMediaTransport implements PinnedMediaTransportPort {
  private readonly dependencies: PinnedMediaTransportDependencies

  constructor(dependencies: Partial<PinnedMediaTransportDependencies> = {}) {
    this.dependencies = { ...productionDependencies, ...dependencies }
  }

  async request(input: PinnedMediaRequest): Promise<SafeMediaResponse> {
    validateInput(input)

    let agent: Agent
    try {
      agent = agentFor(input.route, this.dependencies, input.signal)
    } catch {
      throw failure()
    }

    const originalHostname = bareHostname(input.url)
    const requestOptions: RequestOptions = {
      protocol: 'https:',
      hostname: input.destinationAddress,
      port: this.dependencies.originPort,
      method: 'GET',
      path: `${input.url.pathname}${input.url.search}`,
      headers: { host: input.url.host, accept: '*/*' },
      servername: isIP(originalHostname) === 0 ? originalHostname : undefined,
      checkServerIdentity: (_hostname, certificate) => (
        checkServerIdentity(originalHostname, certificate)
      ),
      rejectUnauthorized: true,
      agent,
      ...(this.dependencies.originCa ? { ca: this.dependencies.originCa } : {}),
    }

    return new Promise<SafeMediaResponse>((resolve, reject) => {
      let request: ClientRequest | undefined
      let response: IncomingMessage | undefined
      let proxySocket: Socket | undefined
      let settled = false
      let requestDestroyed = false
      let responseDestroyed = false
      let proxySocketDestroyed = false
      let gracefulProxyShutdown = false
      let cleaned = false
      let requestStarted = false
      let requestClosed = false
      let responseClosed = false
      let closureStarted = false
      let teardownFinished = false
      let pendingCloseBoundaries = 0
      let markClosed!: () => void
      const closed = new Promise<void>((resolveClosed) => { markClosed = resolveClosed })
      const ownedSockets = new WeakSet<Socket>()

      const maybeCloseLifecycle = (): void => {
        if (
          !closureStarted
          || !teardownFinished
          || (request !== undefined && !requestClosed)
          || (response !== undefined && !responseClosed)
          || pendingCloseBoundaries !== 0
        ) return
        markClosed()
      }
      const trackSocket = (socket: Socket): void => {
        if (ownedSockets.has(socket)) return
        ownedSockets.add(socket)
        if (socket.closed) return
        pendingCloseBoundaries += 1
        socket.once('close', () => {
          pendingCloseBoundaries -= 1
          maybeCloseLifecycle()
        })
      }
      const destroyRequest = (): void => {
        if (requestDestroyed || !request) return
        requestDestroyed = true
        request.destroy()
      }
      const destroyResponse = (): void => {
        if (responseDestroyed || !response) return
        responseDestroyed = true
        response.destroy()
      }
      const destroyProxySocket = (): void => {
        if (proxySocketDestroyed || !proxySocket) return
        proxySocketDestroyed = true
        proxySocket.destroy()
      }
      const cleanup = (): void => {
        if (cleaned) return
        cleaned = true
        input.signal.removeEventListener('abort', onAbort)
        agent.destroy()
      }
      const finishTerminal = (): void => {
        if (teardownFinished) return
        destroyProxySocket()
        destroyResponse()
        destroyRequest()
        cleanup()
        teardownFinished = true
        maybeCloseLifecycle()
      }
      const terminal = (graceful = false): void => {
        if (teardownFinished) return
        if (gracefulProxyShutdown) {
          if (!graceful) finishTerminal()
          return
        }
        if (graceful && proxySocket && !proxySocket.destroyed) {
          gracefulProxyShutdown = true
          const activeProxySocket = proxySocket
          const finishProxy = (): void => {
            if (activeProxySocket.destroyed || activeProxySocket.writableFinished) {
              finishTerminal()
              return
            }
            activeProxySocket.once('finish', finishTerminal)
            activeProxySocket.end()
          }
          const originSocket = response?.socket
          if (originSocket && !originSocket.destroyed && !originSocket.writableFinished) {
            originSocket.once('finish', finishProxy)
            originSocket.end()
          } else {
            finishProxy()
          }
          return
        }
        finishTerminal()
      }
      const closeLifecycle = (graceful = false): Promise<void> => {
        closureStarted = true
        terminal(graceful)
        maybeCloseLifecycle()
        return closed
      }
      const rejectAfterClosure = (): void => {
        if (settled) {
          void closeLifecycle()
          return
        }
        settled = true
        void closeLifecycle().then(() => reject(failure()))
      }
      const fail = (): void => {
        rejectAfterClosure()
      }
      const onAbort = (): void => {
        if (requestStarted && input.route.kind !== 'direct' && !proxySocket) return
        rejectAfterClosure()
      }

      try {
        request = this.dependencies.httpsRequest(requestOptions, (incoming) => {
          response = incoming
          if (incoming.socket) trackSocket(incoming.socket)
          let responseEnded = false
          if (incoming.closed) {
            responseClosed = true
          } else {
            pendingCloseBoundaries += 1
            incoming.once('close', () => {
              responseClosed = true
              pendingCloseBoundaries -= 1
              if (!responseEnded) void closeLifecycle()
              maybeCloseLifecycle()
            })
          }
          incoming.once('end', () => {
            responseEnded = true
            void closeLifecycle(true)
          })
          incoming.once('aborted', () => { void closeLifecycle() })
          incoming.once('error', () => { void closeLifecycle() })

          if (settled) {
            destroyResponse()
            void closeLifecycle()
            return
          }
          const sourceReader = (
            Readable.toWeb(incoming) as ReadableStream<Uint8Array>
          ).getReader()
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const result = await sourceReader.read()
                if (result.done) controller.close()
                else controller.enqueue(result.value)
              } catch {
                const closure = closeLifecycle()
                controller.error(failure())
                await closure
              }
            },
            async cancel() {
              const closure = closeLifecycle()
              try { await sourceReader.cancel() } catch { /* The fixed error boundary owns cancellation. */ }
              await closure
            },
          })

          const safeResponse: SafeMediaResponse = {
            statusCode: incoming.statusCode ?? 0,
            statusMessage: incoming.statusMessage ?? '',
            rawHeaders: [...incoming.rawHeaders],
            body,
            closed,
            cancel: async (): Promise<void> => {
              destroyResponse()
              const closure = closeLifecycle()
              try { await sourceReader.cancel() } catch { /* Teardown never exposes an upstream error. */ }
              await closure
            },
          }
          settled = true
          resolve(safeResponse)
        })
        pendingCloseBoundaries += 1
        request.once('close', () => {
          requestClosed = true
          pendingCloseBoundaries -= 1
          maybeCloseLifecycle()
        })
        request.once('socket', trackSocket)
        request.once('proxy', (event: { socket: Socket }) => {
          proxySocket = event.socket
          trackSocket(event.socket)
          if (teardownFinished) destroyProxySocket()
        })
        request.once('error', fail)
        input.signal.addEventListener('abort', onAbort, { once: true })
        if (input.signal.aborted) onAbort()
        else {
          requestStarted = true
          request.end()
        }
      } catch {
        fail()
      }
    })
  }
}
