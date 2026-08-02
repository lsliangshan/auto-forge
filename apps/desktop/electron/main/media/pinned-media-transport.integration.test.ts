import { readFile } from 'node:fs/promises'
import { createServer as createHttpServer, type IncomingMessage } from 'node:http'
import { createServer as createHttpsServer, request as httpsRequest, type RequestOptions } from 'node:https'
import { createServer as createNetServer, connect as netConnect, type Server, type Socket } from 'node:net'
import { createSecureContext, type TLSSocket } from 'node:tls'
import { afterEach, describe, expect, it } from 'vitest'
import type { MediaRoute } from './media-route.js'
import { PinnedMediaTransport } from './pinned-media-transport.js'

const fixtureDirectory = new URL('./test-fixtures/', import.meta.url)
const key = await readFile(new URL('pinned-media-test-key.pem', fixtureDirectory))
const cert = await readFile(new URL('pinned-media-test-cert.pem', fixtureDirectory))

interface ListenerState {
  sockets: Set<Socket>
  acceptedCount: number
  peerEndCount: number
  closedCount: number
  closePromises: Promise<void>[]
  peerEndWaiters: Set<() => void>
  secureSockets: Set<TLSSocket>
  secureAcceptedCount: number
  secureClosedCount: number
  secureClosePromises: Promise<void>[]
}

const activeServers = new Map<Server, ListenerState>()

async function listen(
  server: Server,
  options: { closeOnPeerEnd?: boolean } = {},
): Promise<number> {
  const state: ListenerState = {
    sockets: new Set<Socket>(),
    acceptedCount: 0,
    peerEndCount: 0,
    closedCount: 0,
    closePromises: [],
    peerEndWaiters: new Set(),
    secureSockets: new Set(),
    secureAcceptedCount: 0,
    secureClosedCount: 0,
    secureClosePromises: [],
  }
  activeServers.set(server, state)
  server.on('connection', (socket) => {
    state.acceptedCount += 1
    state.sockets.add(socket)
    socket.once('end', () => {
      state.peerEndCount += 1
      for (const resolve of state.peerEndWaiters) resolve()
      state.peerEndWaiters.clear()
      if (options.closeOnPeerEnd) socket.destroy()
    })
    state.closePromises.push(new Promise<void>((resolve) => {
      socket.once('close', () => {
        state.closedCount += 1
        state.sockets.delete(socket)
        resolve()
      })
    }))
  })
  server.on('secureConnection', (socket: TLSSocket) => {
    state.secureAcceptedCount += 1
    state.secureSockets.add(socket)
    state.secureClosePromises.push(new Promise<void>((resolve) => {
      socket.once('close', () => {
        state.secureClosedCount += 1
        state.secureSockets.delete(socket)
        resolve()
      })
    }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test listener has no TCP port')
  return address.port
}

async function expectHttpsProxySocketsClosed(
  server: Server,
  expectedTcpCount: number,
  expectedTlsCount: number,
): Promise<void> {
  const state = activeServers.get(server)
  if (!state) throw new Error('Test listener is not tracked')
  expect(state.acceptedCount).toBe(expectedTcpCount)
  expect(state.closePromises).toHaveLength(expectedTcpCount)
  expect(state.secureAcceptedCount).toBe(expectedTlsCount)
  expect(state.secureClosePromises).toHaveLength(expectedTlsCount)
  await Promise.all([...state.closePromises, ...state.secureClosePromises])
  expect(state.closedCount).toBe(expectedTcpCount)
  expect(state.sockets.size).toBe(0)
  expect(state.secureClosedCount).toBe(expectedTlsCount)
  expect(state.secureSockets.size).toBe(0)
}

async function waitForPeerEndCount(state: ListenerState, expectedCount: number): Promise<void> {
  while (state.peerEndCount < expectedCount) {
    await new Promise<void>((resolve) => state.peerEndWaiters.add(resolve))
  }
}

async function expectListenerSocketsClosed(
  server: Server,
  expectedCount: number,
  expectedPeerEndCount = expectedCount,
): Promise<void> {
  const state = activeServers.get(server)
  if (!state) throw new Error('Test listener is not tracked')
  expect(state.acceptedCount).toBe(expectedCount)
  expect(state.closePromises).toHaveLength(expectedCount)
  await waitForPeerEndCount(state, expectedPeerEndCount)
  await Promise.all(state.closePromises)
  expect(state.peerEndCount).toBe(expectedPeerEndCount)
  expect(state.closedCount).toBe(expectedCount)
  expect(state.sockets.size).toBe(0)
}

afterEach(async () => {
  const entries = [...activeServers]
  activeServers.clear()
  await Promise.all(entries.map(async ([server, state]) => {
    for (const socket of state.secureSockets) socket.destroy()
    for (const socket of state.sockets) socket.destroy()
    if (!server.listening) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }))
})

async function originServer(options: { allowHalfOpen?: boolean } = {}) {
  const servernames: string[] = []
  const hosts: Array<string | undefined> = []
  const secureContext = createSecureContext({ key, cert })
  const server = createHttpsServer({
    key,
    cert,
    ...options,
    SNICallback(servername, callback) {
      servernames.push(servername)
      callback(null, secureContext)
    },
  }, (request, response) => {
    hosts.push(request.headers.host)
    response.writeHead(200, { 'content-length': '2' })
    response.end('ok')
  })
  const port = await listen(server)
  return { server, port, servernames, hosts }
}

async function requestThrough(
  originPort: number,
  route: MediaRoute,
  options: { proxyCa?: Buffer } = {},
): Promise<string> {
  const transport = new PinnedMediaTransport({
    originPort,
    originCa: cert,
    ...options,
  })
  const response = await transport.request({
    url: new URL('https://media.test/asset'),
    destinationAddress: '127.0.0.1',
    route,
    signal: new AbortController().signal,
  })
  return new Response(response.body).text()
}

function connectHandler(
  originPort: number,
  authorities: string[],
): (request: IncomingMessage, client: Socket, head: Buffer) => void {
  return (request, client, head) => {
    authorities.push(request.url ?? '')
    const upstream = netConnect(originPort, '127.0.0.1')
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.once('error', () => client.destroy())
  }
}

interface Socks5Observation {
  addressType: number
  address: string
  port: number
}

function socks5Server(originPort: number, observations: Socks5Observation[]): Server {
  return createNetServer((client) => {
    let pending = Buffer.alloc(0)
    let state: 'greeting' | 'connect' = 'greeting'

    const onData = (chunk: Buffer): void => {
      pending = Buffer.concat([pending, chunk])
      if (state === 'greeting') {
        if (pending.length < 2) return
        const greetingLength = 2 + pending[1]!
        if (pending.length < greetingLength) return
        pending = pending.subarray(greetingLength)
        client.write(Buffer.from([0x05, 0x00]))
        state = 'connect'
      }
      if (state !== 'connect' || pending.length < 4) return

      const addressType = pending[3]!
      const addressLength = addressType === 0x01
        ? 4
        : addressType === 0x04
          ? 16
          : pending.length >= 5
            ? 1 + pending[4]!
            : Number.POSITIVE_INFINITY
      const requestLength = 4 + addressLength + 2
      if (pending.length < requestLength) return

      let address: string
      if (addressType === 0x01) {
        address = [...pending.subarray(4, 8)].join('.')
      } else if (addressType === 0x03) {
        address = pending.subarray(5, 5 + pending[4]!).toString('utf8')
      } else {
        address = pending.subarray(4, 4 + addressLength).toString('hex')
      }
      const port = pending.readUInt16BE(4 + addressLength)
      const head = pending.subarray(requestLength)
      observations.push({ addressType, address, port })
      client.off('data', onData)

      const upstream = netConnect(originPort, '127.0.0.1')
      upstream.once('connect', () => {
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]))
        if (head.length > 0) upstream.write(head)
        upstream.pipe(client)
        client.pipe(upstream)
      })
      upstream.once('error', () => client.destroy())
    }

    client.on('data', onData)
  })
}

interface Socks4Observation {
  address: string
  port: number
  hasDomainSuffix: boolean
}

function socks4Server(originPort: number, observations: Socks4Observation[]): Server {
  return createNetServer((client) => {
    let pending = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      pending = Buffer.concat([pending, chunk])
      if (pending.length < 9) return
      const userEnd = pending.indexOf(0x00, 8)
      if (userEnd === -1) return

      const addressBytes = pending.subarray(4, 8)
      const socks4a = addressBytes[0] === 0 && addressBytes[1] === 0
        && addressBytes[2] === 0 && addressBytes[3] !== 0
      let requestLength = userEnd + 1
      if (socks4a) {
        const domainEnd = pending.indexOf(0x00, requestLength)
        if (domainEnd === -1) return
        requestLength = domainEnd + 1
      }
      const head = pending.subarray(requestLength)
      observations.push({
        address: [...addressBytes].join('.'),
        port: pending.readUInt16BE(2),
        hasDomainSuffix: socks4a,
      })
      client.off('data', onData)

      const upstream = netConnect(originPort, '127.0.0.1')
      upstream.once('connect', () => {
        client.write(Buffer.from([0x00, 0x5a, pending[2]!, pending[3]!, ...addressBytes]))
        if (head.length > 0) upstream.write(head)
        upstream.pipe(client)
        client.pipe(upstream)
      })
      upstream.once('error', () => client.destroy())
    }

    client.on('data', onData)
  })
}

describe('PinnedMediaTransport loopback routing', () => {
  it('connects directly to the numeric address with original SNI and Host despite proxy environment variables', async () => {
    const origin = await originServer()
    const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'] as const
    const previous = new Map(names.map((name) => [name, process.env[name]]))
    process.env.HTTP_PROXY = 'http://127.0.0.1:1'
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1'
    process.env.ALL_PROXY = 'socks5://127.0.0.1:1'

    try {
      await expect(requestThrough(origin.port, { kind: 'direct' })).resolves.toBe('ok')
    } finally {
      for (const name of names) {
        const value = previous.get(name)
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }

    await expectListenerSocketsClosed(origin.server, 1, 0)
    expect(origin.servernames).toEqual(['media.test'])
    expect(origin.hosts).toEqual(['media.test'])
  })

  it('uses the numeric destination as the HTTP CONNECT authority', async () => {
    const origin = await originServer()
    const connectAuthorities: string[] = []
    const proxy = createHttpServer()
    proxy.on('connect', connectHandler(origin.port, connectAuthorities))
    const proxyPort = await listen(proxy, { closeOnPeerEnd: true })

    await expect(requestThrough(origin.port, {
      kind: 'http-connect',
      proxyUrl: `http://127.0.0.1:${proxyPort}`,
    })).resolves.toBe('ok')

    await expectListenerSocketsClosed(origin.server, 1, 0)
    await expectListenerSocketsClosed(proxy, 1)
    expect(connectAuthorities).toEqual([`127.0.0.1:${origin.port}`])
    expect(connectAuthorities[0]).not.toContain('media.test')
    expect(origin.servernames).toEqual(['media.test'])
    expect(origin.hosts).toEqual(['media.test'])
  })

  it('finishes local cleanup when the origin keeps its TLS writable side open', async () => {
    const origin = await originServer({ allowHalfOpen: true })
    let originTlsClosed = false
    const originTlsEnded = new Promise<void>((resolve) => {
      origin.server.once('secureConnection', (socket) => {
        socket.once('end', resolve)
        socket.once('close', () => { originTlsClosed = true })
      })
    })
    const proxy = createHttpServer()
    proxy.on('connect', connectHandler(origin.port, []))
    const proxyPort = await listen(proxy, { closeOnPeerEnd: true })
    let requestDestroyCount = 0
    let agentDestroyCount = 0
    const observedHttpsRequest = ((
      requestOptions: RequestOptions,
      callback: (response: IncomingMessage) => void,
    ) => {
      const agent = requestOptions.agent
      if (!agent || typeof agent === 'boolean') throw new Error('Expected a per-request agent')
      const originalAgentDestroy = agent.destroy.bind(agent)
      agent.destroy = () => {
        agentDestroyCount += 1
        originalAgentDestroy()
      }
      const request = httpsRequest(requestOptions, callback)
      const originalRequestDestroy = request.destroy.bind(request)
      request.destroy = ((error?: Error) => {
        requestDestroyCount += 1
        return originalRequestDestroy(error)
      }) as typeof request.destroy
      return request
    }) as typeof httpsRequest
    const transport = new PinnedMediaTransport({
      httpsRequest: observedHttpsRequest,
      originPort: origin.port,
      originCa: cert,
    })

    const response = await transport.request({
      url: new URL('https://media.test/asset'),
      destinationAddress: '127.0.0.1',
      route: {
        kind: 'http-connect',
        proxyUrl: `http://127.0.0.1:${proxyPort}`,
      },
      signal: new AbortController().signal,
    })
    await expect(new Response(response.body).text()).resolves.toBe('ok')

    await originTlsEnded
    expect(originTlsClosed).toBe(false)
    expect(requestDestroyCount).toBe(1)
    expect(agentDestroyCount).toBe(1)
    await expectListenerSocketsClosed(proxy, 1)
  }, 1_000)

  it('verifies the HTTPS proxy certificate while keeping CONNECT numeric', async () => {
    const origin = await originServer()
    const connectAuthorities: string[] = []
    const proxy = createHttpsServer({ key, cert })
    proxy.on('connect', connectHandler(origin.port, connectAuthorities))
    const proxyPort = await listen(proxy, { closeOnPeerEnd: true })
    const route = {
      kind: 'http-connect' as const,
      proxyUrl: `https://127.0.0.1:${proxyPort}`,
    }

    await expect(requestThrough(origin.port, route, { proxyCa: cert })).resolves.toBe('ok')
    await expect(requestThrough(origin.port, route)).rejects.toMatchObject({
      code: 'MEDIA_DOWNLOAD_FAILED',
    })

    await expectListenerSocketsClosed(origin.server, 1, 0)
    await expectHttpsProxySocketsClosed(proxy, 2, 1)
    expect(connectAuthorities).toEqual([`127.0.0.1:${origin.port}`])
    expect(connectAuthorities[0]).not.toContain('media.test')
    expect(origin.servernames).toEqual(['media.test'])
    expect(origin.hosts).toEqual(['media.test'])
  })

  it('uses IPv4 ATYP with the numeric destination over SOCKS5', async () => {
    const origin = await originServer()
    const observations: Socks5Observation[] = []
    const proxy = socks5Server(origin.port, observations)
    const proxyPort = await listen(proxy, { closeOnPeerEnd: true })

    await expect(requestThrough(origin.port, {
      kind: 'socks',
      proxyUrl: `socks5://127.0.0.1:${proxyPort}`,
    })).resolves.toBe('ok')

    await expectListenerSocketsClosed(origin.server, 1, 0)
    await expectListenerSocketsClosed(proxy, 1)
    expect(observations).toEqual([{
      addressType: 0x01,
      address: '127.0.0.1',
      port: origin.port,
    }])
    expect(observations.some(({ addressType }) => addressType === 0x03)).toBe(false)
    expect(origin.servernames).toEqual(['media.test'])
    expect(origin.hosts).toEqual(['media.test'])
  })

  it('uses the four numeric address bytes without a SOCKS4a domain suffix', async () => {
    const origin = await originServer()
    const observations: Socks4Observation[] = []
    const proxy = socks4Server(origin.port, observations)
    const proxyPort = await listen(proxy, { closeOnPeerEnd: true })

    await expect(requestThrough(origin.port, {
      kind: 'socks',
      proxyUrl: `socks4://127.0.0.1:${proxyPort}`,
    })).resolves.toBe('ok')

    await expectListenerSocketsClosed(origin.server, 1, 0)
    await expectListenerSocketsClosed(proxy, 1)
    expect(observations).toEqual([{
      address: '127.0.0.1',
      port: origin.port,
      hasDomainSuffix: false,
    }])
    expect(origin.servernames).toEqual(['media.test'])
    expect(origin.hosts).toEqual(['media.test'])
  })
})
