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
      let pendingNegotiationAbort = false
      let abortRejection: Promise<void> | undefined
      let markRequestClosed!: () => void
      const requestClosure = new Promise<void>((resolveClosure) => {
        markRequestClosed = resolveClosure
      })
      let proxySocketClosure: Promise<void> | undefined

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
        destroyProxySocket()
        destroyResponse()
        destroyRequest()
        cleanup()
      }
      const terminal = (graceful = false): void => {
        if (cleaned) return
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
      const rejectSafely = (): void => {
        if (settled) return
        settled = true
        reject(failure())
      }
      const rejectAfterAbortClosure = (): void => {
        abortRejection ??= (async () => {
          terminal()
          if (request && !requestClosed) await requestClosure
          if (proxySocketClosure) await proxySocketClosure
          if (pendingNegotiationAbort) {
            // Let the peer observe the signal-closed negotiation socket before the lease can continue.
            await new Promise<void>((resolveTurn) => setTimeout(resolveTurn, 0))
          }
          rejectSafely()
        })()
      }
      const fail = (): void => {
        if (input.signal.aborted) {
          rejectAfterAbortClosure()
          return
        }
        terminal()
        rejectSafely()
      }
      const onAbort = (): void => {
        if (requestStarted && input.route.kind !== 'direct' && !proxySocket) {
          pendingNegotiationAbort = true
          return
        }
        rejectAfterAbortClosure()
      }

      try {
        request = this.dependencies.httpsRequest(requestOptions, (incoming) => {
          response = incoming
          let responseEnded = false
          incoming.once('end', () => {
            responseEnded = true
            terminal(true)
          })
          incoming.once('aborted', terminal)
          incoming.once('error', terminal)
          incoming.once('close', () => {
            if (!responseEnded) terminal()
          })

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
                terminal()
                controller.error(failure())
              }
            },
            async cancel() {
              try { await sourceReader.cancel() } catch { /* The fixed error boundary owns cancellation. */ }
              terminal()
            },
          })

          const safeResponse: SafeMediaResponse = {
            statusCode: incoming.statusCode ?? 0,
            statusMessage: incoming.statusMessage ?? '',
            rawHeaders: [...incoming.rawHeaders],
            body,
            cancel: async (): Promise<void> => {
              destroyResponse()
              terminal()
              try { await sourceReader.cancel() } catch { /* Teardown never exposes an upstream error. */ }
            },
          }
          if (settled) {
            destroyResponse()
            terminal()
            return
          }
          settled = true
          resolve(safeResponse)
        })
        request.once('proxy', (event: { socket: Socket }) => {
          proxySocket = event.socket
          proxySocketClosure = event.socket.destroyed
            ? Promise.resolve()
            : new Promise<void>((resolveClosure) => event.socket.once('close', resolveClosure))
          if (cleaned) destroyProxySocket()
        })
        request.once('close', () => {
          requestClosed = true
          markRequestClosed()
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
