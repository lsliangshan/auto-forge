import { EventEmitter } from 'node:events'
import { Agent, type RequestOptions, request as httpsRequest } from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { describe, expect, it, vi } from 'vitest'
import type { MediaRoute } from './media-route.js'
import { PinnedMediaTransport } from './pinned-media-transport.js'

const SAFE_ERROR = {
  code: 'MEDIA_DOWNLOAD_FAILED',
  message: 'The media download failed.',
}

class FakeIncomingMessage extends Readable {
  statusCode = 206
  statusMessage = 'Partial Content'
  rawHeaders = ['content-type', 'image/png']

  _read(): void {}
}

interface RequestHarness {
  request: ClientRequest
  destroy: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  httpsRequest: typeof httpsRequest
  options(): RequestOptions
  respond(response?: FakeIncomingMessage): FakeIncomingMessage
}

function requestHarness(): RequestHarness {
  const emitter = new EventEmitter()
  const destroy = vi.fn()
  const end = vi.fn()
  const request = Object.assign(emitter, { destroy, end }) as unknown as ClientRequest
  let capturedOptions: RequestOptions | undefined
  let callback: ((response: IncomingMessage) => void) | undefined
  const requestSpy = vi.fn((
    options: RequestOptions,
    responseCallback: (response: IncomingMessage) => void,
  ) => {
    capturedOptions = options
    callback = responseCallback
    return request
  }) as unknown as typeof httpsRequest

  return {
    request,
    destroy,
    end,
    httpsRequest: requestSpy,
    options: () => {
      if (!capturedOptions) throw new Error('No request options captured')
      return capturedOptions
    },
    respond: (response = new FakeIncomingMessage()) => {
      if (!callback) throw new Error('No response callback captured')
      callback(response as unknown as IncomingMessage)
      return response
    },
  }
}

function input(
  route: MediaRoute = { kind: 'direct' },
  overrides: Partial<{
    url: URL
    destinationAddress: string
    signal: AbortSignal
  }> = {},
) {
  return {
    url: new URL('https://media.example/asset.png?size=2'),
    destinationAddress: '93.184.216.34',
    route,
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe('PinnedMediaTransport request boundary', () => {
  it('connects to the numeric destination while preserving DNS TLS and HTTP identity', async () => {
    const harness = requestHarness()
    const transport = new PinnedMediaTransport({ httpsRequest: harness.httpsRequest })

    const pending = transport.request(input())

    expect(harness.httpsRequest).toHaveBeenCalledWith(expect.objectContaining({
      protocol: 'https:',
      hostname: '93.184.216.34',
      port: 443,
      servername: 'media.example',
      method: 'GET',
      path: '/asset.png?size=2',
      headers: { host: 'media.example', accept: '*/*' },
      agent: expect.anything(),
      signal: expect.any(AbortSignal),
    }), expect.any(Function))
    expect(harness.end).toHaveBeenCalledOnce()

    const incoming = harness.respond()
    const response = await pending
    expect(response).toMatchObject({
      statusCode: 206,
      statusMessage: 'Partial Content',
      rawHeaders: ['content-type', 'image/png'],
    })
    await response.cancel()
    incoming.destroy()
  })

  it.each([
    ['direct', { kind: 'direct' } as const, Agent],
    ['HTTP CONNECT', { kind: 'http-connect', proxyUrl: 'http://proxy.test:8080' } as const, HttpsProxyAgent],
    ['HTTPS CONNECT', { kind: 'http-connect', proxyUrl: 'https://proxy.test:8443' } as const, HttpsProxyAgent],
    ['SOCKS', { kind: 'socks', proxyUrl: 'socks5://proxy.test:1080' } as const, SocksProxyAgent],
  ])('constructs a fresh %s agent without changing origin options', async (_, route, AgentType) => {
    const firstHarness = requestHarness()
    const secondHarness = requestHarness()
    const first = new PinnedMediaTransport({ httpsRequest: firstHarness.httpsRequest })
    const second = new PinnedMediaTransport({ httpsRequest: secondHarness.httpsRequest })

    const firstPending = first.request(input(route))
    const secondPending = second.request(input(route))

    expect(firstHarness.options()).toMatchObject({
      hostname: '93.184.216.34',
      servername: 'media.example',
      headers: { host: 'media.example', accept: '*/*' },
    })
    expect(firstHarness.options().agent).toBeInstanceOf(AgentType)
    expect(secondHarness.options().agent).toBeInstanceOf(AgentType)
    expect(secondHarness.options().agent).not.toBe(firstHarness.options().agent)

    firstHarness.respond()
    secondHarness.respond()
    await (await firstPending).cancel()
    await (await secondPending).cancel()
  })

  it('omits SNI for an IP-literal URL and preserves its literal Host identity', async () => {
    const harness = requestHarness()
    const transport = new PinnedMediaTransport({ httpsRequest: harness.httpsRequest })

    const pending = transport.request(input({ kind: 'direct' }, {
      url: new URL('https://93.184.216.34/asset'),
    }))
    const ipLiteralOptions = harness.options()

    expect(ipLiteralOptions.servername).toBeUndefined()
    expect(ipLiteralOptions.headers).toMatchObject({ host: '93.184.216.34' })
    harness.respond()
    await (await pending).cancel()
  })

  it.each([
    ['a non-IP destination', input({ kind: 'direct' }, { destinationAddress: 'not-an-ip' })],
    ['a non-HTTPS URL', input({ kind: 'direct' }, { url: new URL('http://media.example/') })],
    ['an explicit origin port', input({ kind: 'direct' }, { url: new URL('https://media.example:8443/') })],
    ['URL credentials', input({ kind: 'direct' }, { url: new URL('https://user:secret@media.example/') })],
    ['an unexpected route', input({ kind: 'unexpected' } as never)],
  ])('rejects %s before opening a request', async (_, invalidInput) => {
    const harness = requestHarness()
    const transport = new PinnedMediaTransport({ httpsRequest: harness.httpsRequest })

    await expect(transport.request(invalidInput)).rejects.toMatchObject(SAFE_ERROR)
    expect(harness.httpsRequest).not.toHaveBeenCalled()
  })

  it.each(['socks4:', 'socks4a:'])(
    'rejects an IPv6 destination for %s before it can become a SOCKS4a suffix',
    async (protocol) => {
      const unexpectedRequest = vi.fn(() => {
        throw new Error('A rejected SOCKS4 destination must not open a request')
      }) as unknown as typeof httpsRequest
      const transport = new PinnedMediaTransport({ httpsRequest: unexpectedRequest })

      await expect(transport.request(input({
        kind: 'socks',
        proxyUrl: `${protocol}//127.0.0.1:1080`,
      }, {
        destinationAddress: '2001:4860:4860::8888',
      }))).rejects.toMatchObject(SAFE_ERROR)
      expect(unexpectedRequest).not.toHaveBeenCalled()
    },
  )
})

describe('PinnedMediaTransport lifecycle', () => {
  it('destroys the request and agent once when aborted before response headers', async () => {
    const harness = requestHarness()
    const controller = new AbortController()
    const transport = new PinnedMediaTransport({ httpsRequest: harness.httpsRequest })
    const pending = transport.request(input({ kind: 'direct' }, { signal: controller.signal }))
    const agent = harness.options().agent as Agent
    const destroyAgent = vi.spyOn(agent, 'destroy')

    controller.abort(new Error('private abort reason'))
    harness.request.emit('error', new Error('late request error'))

    await expect(pending).rejects.toMatchObject(SAFE_ERROR)
    expect(harness.destroy).toHaveBeenCalledOnce()
    expect(harness.destroy).toHaveBeenCalledWith()
    expect(destroyAgent).toHaveBeenCalledOnce()
  })

  it('destroys the per-request agent when the response reaches EOF', async () => {
    const harness = requestHarness()
    const transport = new PinnedMediaTransport({ httpsRequest: harness.httpsRequest })
    const pending = transport.request(input())
    const agent = harness.options().agent as Agent
    const destroyAgent = vi.spyOn(agent, 'destroy')
    const incoming = harness.respond()

    await pending
    incoming.emit('end')

    expect(destroyAgent).toHaveBeenCalledOnce()
  })

  it.each(['aborted', 'error'] as const)(
    'destroys the request and agent when the response emits %s',
    async (event) => {
      const harness = requestHarness()
      const transport = new PinnedMediaTransport({ httpsRequest: harness.httpsRequest })
      const pending = transport.request(input())
      const agent = harness.options().agent as Agent
      const destroyAgent = vi.spyOn(agent, 'destroy')
      const incoming = harness.respond()

      await pending
      incoming.emit(event, new Error('private response failure'))

      expect(harness.destroy).toHaveBeenCalledOnce()
      expect(destroyAgent).toHaveBeenCalledOnce()
    },
  )

  it('cancels without exposing the reason and tears down response, request, and agent idempotently', async () => {
    const harness = requestHarness()
    const transport = new PinnedMediaTransport({ httpsRequest: harness.httpsRequest })
    const pending = transport.request(input())
    const agent = harness.options().agent as Agent
    const destroyAgent = vi.spyOn(agent, 'destroy')
    const incoming = harness.respond()
    const destroyResponse = vi.spyOn(incoming, 'destroy')
    const response = await pending
    const secretError = new Error('private cancellation detail')

    await expect(response.cancel(secretError)).resolves.toBeUndefined()
    await expect(response.cancel(secretError)).resolves.toBeUndefined()

    expect(destroyResponse).toHaveBeenCalledOnce()
    expect(destroyResponse).toHaveBeenCalledWith()
    expect(harness.destroy).toHaveBeenCalledOnce()
    expect(harness.destroy).toHaveBeenCalledWith()
    expect(destroyAgent).toHaveBeenCalledOnce()
  })

  it('maps request errors before headers to the safe failure and destroys resources', async () => {
    const harness = requestHarness()
    const transport = new PinnedMediaTransport({ httpsRequest: harness.httpsRequest })
    const pending = transport.request(input())
    const agent = harness.options().agent as Agent
    const destroyAgent = vi.spyOn(agent, 'destroy')

    harness.request.emit('error', new Error('private request detail'))

    await expect(pending).rejects.toMatchObject(SAFE_ERROR)
    expect(harness.destroy).toHaveBeenCalledOnce()
    expect(destroyAgent).toHaveBeenCalledOnce()
  })

  it('copies header metadata defensively when settling at response headers', async () => {
    const harness = requestHarness()
    const transport = new PinnedMediaTransport({ httpsRequest: harness.httpsRequest })
    const pending = transport.request(input())
    const incoming = harness.respond()
    const response = await pending

    incoming.statusCode = 500
    incoming.statusMessage = 'Changed'
    incoming.rawHeaders.push('x-private', 'changed')

    expect(response).toMatchObject({
      statusCode: 206,
      statusMessage: 'Partial Content',
      rawHeaders: ['content-type', 'image/png'],
    })
    await response.cancel()
  })
})
