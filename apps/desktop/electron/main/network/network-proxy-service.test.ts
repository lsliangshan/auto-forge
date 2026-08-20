import { normalizeProxySettings } from '@autoforge/shared'
import { describe, expect, it, vi } from 'vitest'
import {
  NetworkProxyService,
  proxyConfigFor,
  type ProxySessionPort,
  type NetworkTransportSnapshot,
} from './network-proxy-service.js'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

interface FakeProxySession extends ProxySessionPort {
  setProxy: ReturnType<typeof vi.fn<ProxySessionPort['setProxy']>>
  closeAllConnections: ReturnType<typeof vi.fn<ProxySessionPort['closeAllConnections']>>
  fetch: ReturnType<typeof vi.fn<ProxySessionPort['fetch']>>
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function fakeSession(): FakeProxySession {
  return {
    setProxy: vi.fn(async () => undefined),
    closeAllConnections: vi.fn(async () => undefined),
    fetch: vi.fn(async () => new Response(null, { status: 204 })),
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const directSettings = normalizeProxySettings({ enabled: false, bypassDomains: [] })

function proxySettings(port: number) {
  return normalizeProxySettings({
    enabled: true,
    httpProxy: `http://127.0.0.1:${port}`,
    bypassDomains: ['example.com'],
  })
}

describe('proxyConfigFor', () => {
  it('routes HTTP, HTTPS, and SOCKS deterministically with local bypass', () => {
    const enabled = normalizeProxySettings({
      enabled: true,
      httpProxy: 'http://127.0.0.1:7890',
      socketProxy: 'socks5://127.0.0.1:7891',
      bypassDomains: ['example.com'],
    })

    expect(proxyConfigFor(enabled)).toEqual({
      electron: {
        mode: 'fixed_servers',
        proxyRules: [
          'http=http://127.0.0.1:7890',
          'https=socks5://127.0.0.1:7891',
          'socks=socks5://127.0.0.1:7891',
        ].join(';'),
        proxyBypassRules: '<local>,example.com',
      },
      snapshot: {
        enabled: true,
        proxyRules: expect.any(String),
        bypassRules: '<local>,example.com',
      },
      settings: enabled,
    })
  })

  it('uses direct mode without direct proxy pseudo-rules', () => {
    expect(proxyConfigFor({ enabled: false, bypassDomains: [] })).toEqual({
      electron: { mode: 'direct' },
      snapshot: {
        enabled: false,
        bypassRules: '<local>',
      },
      settings: { enabled: false, bypassDomains: [] },
    })
  })

  it('uses an HTTPS proxy for both HTTP and HTTPS when it is the only proxy', () => {
    const config = proxyConfigFor(normalizeProxySettings({
      enabled: true,
      httpsProxy: 'https://proxy.example:8443',
      bypassDomains: [],
    }))

    expect(config.electron).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'http=https://proxy.example:8443;https=https://proxy.example:8443',
      proxyBypassRules: '<local>',
    })
  })

  it('uses a SOCKS proxy for HTTP, HTTPS, and SOCKS when it is the only proxy', () => {
    const config = proxyConfigFor(normalizeProxySettings({
      enabled: true,
      socketProxy: 'socks5://proxy.example:1080',
      bypassDomains: [],
    }))

    expect(config.electron).toEqual({
      mode: 'fixed_servers',
      proxyRules: [
        'http=socks5://proxy.example:1080',
        'https=socks5://proxy.example:1080',
        'socks=socks5://proxy.example:1080',
      ].join(';'),
      proxyBypassRules: '<local>',
    })
  })

  it('deduplicates bypass rules while always keeping local addresses first', () => {
    const config = proxyConfigFor(normalizeProxySettings({
      enabled: true,
      httpProxy: 'http://proxy.example:8080',
      bypassDomains: ['example.com', 'EXAMPLE.com', 'internal.example'],
    }))

    expect(config.electron.proxyBypassRules).toBe('<local>,example.com,internal.example')
    expect(config.snapshot.bypassRules).toBe('<local>,example.com,internal.example')
  })

  it('never emits direct proxy pseudo-rules', () => {
    const configs = [
      proxyConfigFor({ enabled: false, bypassDomains: [] }),
      proxyConfigFor(normalizeProxySettings({
        enabled: true,
        httpProxy: 'http://proxy.example:8080',
        bypassDomains: [],
      })),
    ]

    expect(JSON.stringify(configs)).not.toContain('direct://')
  })
})

describe('NetworkProxyService', () => {
  it('holds an immutable transport settings snapshot until the operation settles', async () => {
    const session = fakeSession()
    const service = new NetworkProxyService(session)
    const active = proxySettings(7890)
    await service.initialize(active)
    const operationDone = deferred<void>()
    let captured!: NetworkTransportSnapshot

    const lease = service.withTransportLease(async (snapshot) => {
      captured = snapshot
      await operationDone.promise
    })
    await flushMicrotasks()

    expect(Object.isFrozen(captured)).toBe(true)
    expect(Object.isFrozen(captured.settings)).toBe(true)
    expect(Object.isFrozen(captured.settings.bypassDomains)).toBe(true)
    expect(() => { captured.settings.enabled = false }).toThrow()
    expect(() => { captured.settings.bypassDomains.push('mutated.example') }).toThrow()

    const transition = service.transition(proxySettings(7891))
    await flushMicrotasks()
    expect(session.setProxy).not.toHaveBeenLastCalledWith(
      proxyConfigFor(proxySettings(7891)).electron,
    )

    operationDone.resolve()
    await lease
    await transition
    expect(session.setProxy).toHaveBeenLastCalledWith(
      proxyConfigFor(proxySettings(7891)).electron,
    )
  })

  it('releases a transport lease when the operation rejects', async () => {
    const service = new NetworkProxyService(fakeSession())
    const secretError = new Error('operation detail')

    await expect(service.withTransportLease(async () => {
      throw secretError
    })).rejects.toBe(secretError)

    await expect(service.transition(proxySettings(7892))).resolves.toBeUndefined()
  })

  it('holds a fetch lease until the response body ends and gates new fetches', async () => {
    const session = fakeSession()
    const firstBody = deferred<ReadableStreamReadResult<Uint8Array>>()
    session.fetch.mockResolvedValueOnce(new Response(new ReadableStream({
      pull(controller) {
        return firstBody.promise.then((result) => {
          if (result.done) controller.close()
          else controller.enqueue(result.value)
        })
      },
    })))
    const service = new NetworkProxyService(session)
    const nextSettings = proxySettings(7890)

    const response = await service.fetch('https://example.com')
    const reader = response.body!.getReader()
    const transition = service.transition(nextSettings)
    const queuedFetch = service.fetch('https://after.example')
    await flushMicrotasks()

    expect(session.setProxy).not.toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'fixed_servers' }),
    )
    expect(session.fetch).toHaveBeenCalledTimes(1)

    firstBody.resolve({ done: true, value: undefined })
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
    await transition
    await queuedFetch

    expect(session.setProxy).toHaveBeenLastCalledWith(proxyConfigFor(nextSettings).electron)
    expect(session.closeAllConnections).toHaveBeenCalledOnce()
    expect(session.fetch).toHaveBeenCalledTimes(2)
  })

  it('cancels a fetch waiting behind the entry barrier without reaching the session', async () => {
    const session = fakeSession()
    const apply = deferred<void>()
    session.setProxy.mockImplementationOnce(() => apply.promise)
    const service = new NetworkProxyService(session)
    const transition = service.transition(proxySettings(7890))
    const controller = new AbortController()
    const abortReason = new DOMException('cancelled', 'AbortError')
    const result = service.fetch('https://cancelled.example', {
      signal: controller.signal,
    }).then(() => undefined, (error: unknown) => error)
    const settled = vi.fn()
    void result.then(settled)

    try {
      await flushMicrotasks()
      expect(session.fetch).not.toHaveBeenCalled()

      controller.abort(abortReason)
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(settled).toHaveBeenCalledOnce()
      await expect(result).resolves.toBe(abortReason)
    } finally {
      apply.resolve()
      await transition
    }

    await flushMicrotasks()
    expect(session.fetch).not.toHaveBeenCalled()
  })

  it('releases a fetch lease when the response body is cancelled', async () => {
    const session = fakeSession()
    const cancelled = vi.fn()
    session.fetch.mockResolvedValueOnce(new Response(new ReadableStream({
      pull() { return new Promise<void>(() => undefined) },
      cancel(reason) { cancelled(reason) },
    }, { highWaterMark: 0 })))
    const service = new NetworkProxyService(session)

    const response = await service.fetch('https://example.com')
    let transitioned = false
    const transition = service.transition(proxySettings(7890)).then(() => { transitioned = true })
    await flushMicrotasks()
    expect(transitioned).toBe(false)

    await response.body!.cancel('not-needed')
    await transition

    expect(cancelled).toHaveBeenCalledWith('not-needed')
    expect(transitioned).toBe(true)
  })

  it('releases a fetch lease and preserves the error when a body read fails', async () => {
    const session = fakeSession()
    const bodyRead = deferred<void>()
    const bodyError = new Error('provider stream failed')
    session.fetch.mockResolvedValueOnce(new Response(new ReadableStream({
      pull() { return bodyRead.promise.then(() => { throw bodyError }) },
    }, { highWaterMark: 0 })))
    const service = new NetworkProxyService(session)

    const response = await service.fetch('https://example.com')
    const reading = expect(response.body!.getReader().read()).rejects.toBe(bodyError)
    const transition = service.transition(proxySettings(7890))
    await flushMicrotasks()
    expect(session.setProxy).not.toHaveBeenCalled()

    bodyRead.resolve()
    await reading
    await transition

    expect(session.setProxy).toHaveBeenCalledWith(proxyConfigFor(proxySettings(7890)).electron)
  })

  it('releases a body-less response immediately', async () => {
    const session = fakeSession()
    const service = new NetworkProxyService(session)

    const response = await service.fetch('https://example.com')
    await service.transition(proxySettings(7890))

    expect(response.body).toBeNull()
    expect(response.status).toBe(204)
    expect(session.setProxy).toHaveBeenCalledOnce()
  })

  it('releases a fetch lease when the session fetch rejects', async () => {
    const session = fakeSession()
    const providerError = new Error('provider request failed')
    session.fetch.mockRejectedValueOnce(providerError)
    const service = new NetworkProxyService(session)

    await expect(service.fetch('https://example.com')).rejects.toBe(providerError)
    await service.transition(proxySettings(7890))

    expect(session.setProxy).toHaveBeenCalledOnce()
  })

  it('preserves response status, status text, and headers while wrapping the body', async () => {
    const session = fakeSession()
    session.fetch.mockResolvedValueOnce(new Response('denied', {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'retry-after': '30', 'x-request-id': 'request-1' },
    }))
    const service = new NetworkProxyService(session)

    const response = await service.fetch('https://example.com')

    expect(response.status).toBe(429)
    expect(response.statusText).toBe('Too Many Requests')
    expect(Object.fromEntries(response.headers)).toEqual({
      'content-type': 'text/plain;charset=UTF-8',
      'retry-after': '30',
      'x-request-id': 'request-1',
    })
    await expect(response.text()).resolves.toBe('denied')
  })

  it('serializes transitions and keeps fetches gated through the whole queue', async () => {
    const session = fakeSession()
    const firstApply = deferred<void>()
    const secondApply = deferred<void>()
    session.setProxy
      .mockImplementationOnce(() => firstApply.promise)
      .mockImplementationOnce(() => secondApply.promise)
    const service = new NetworkProxyService(session)
    const firstSettings = proxySettings(7890)
    const secondSettings = proxySettings(7891)

    const first = service.transition(firstSettings)
    const second = service.transition(secondSettings)
    const queuedFetch = service.fetch('https://after.example')
    await flushMicrotasks()

    expect(session.setProxy).toHaveBeenCalledTimes(1)
    expect(session.setProxy).toHaveBeenNthCalledWith(1, proxyConfigFor(firstSettings).electron)
    expect(session.fetch).not.toHaveBeenCalled()

    firstApply.resolve()
    await first
    await flushMicrotasks()
    expect(session.setProxy).toHaveBeenCalledTimes(2)
    expect(session.setProxy).toHaveBeenNthCalledWith(2, proxyConfigFor(secondSettings).electron)
    expect(session.fetch).not.toHaveBeenCalled()

    secondApply.resolve()
    await second
    await queuedFetch

    expect(session.closeAllConnections).toHaveBeenCalledTimes(2)
    expect(session.fetch).toHaveBeenCalledOnce()
  })

  it('gates snapshots during transition and returns immutable defensive copies', async () => {
    const session = fakeSession()
    const service = new NetworkProxyService(session)
    const firstSettings = proxySettings(7890)
    await service.initialize(firstSettings)
    const first = await service.snapshot()

    expect(Object.isFrozen(first)).toBe(true)
    const second = await service.snapshot()
    expect(second).toEqual(proxyConfigFor(firstSettings).snapshot)
    expect(second).not.toBe(first)

    const apply = deferred<void>()
    session.setProxy.mockImplementationOnce(() => apply.promise)
    const nextSettings = proxySettings(7891)
    const transition = service.transition(nextSettings)
    let snapshotResolved = false
    const pendingSnapshot = service.snapshot().then((value) => {
      snapshotResolved = true
      return value
    })
    await flushMicrotasks()
    expect(snapshotResolved).toBe(false)

    apply.resolve()
    await transition
    await expect(pendingSnapshot).resolves.toEqual(proxyConfigFor(nextSettings).snapshot)
  })

  it('initializes the saved config before accepting fetch leases', async () => {
    const session = fakeSession()
    const apply = deferred<void>()
    session.setProxy.mockImplementationOnce(() => apply.promise)
    const service = new NetworkProxyService(session)
    const savedSettings = proxySettings(7890)

    const initialization = service.initialize(savedSettings)
    const queuedFetch = service.fetch('https://example.com')
    await flushMicrotasks()

    expect(session.setProxy).toHaveBeenCalledWith(proxyConfigFor(savedSettings).electron)
    expect(session.fetch).not.toHaveBeenCalled()

    apply.resolve()
    await initialization
    await queuedFetch
    expect(session.fetch).toHaveBeenCalledOnce()
  })

  it('restores the previous config and safe error when setProxy fails', async () => {
    const session = fakeSession()
    const service = new NetworkProxyService(session)
    const previousSettings = proxySettings(7890)
    const nextSettings = proxySettings(7891)
    await service.initialize(previousSettings)
    session.setProxy.mockClear()
    session.closeAllConnections.mockClear()
    session.setProxy
      .mockRejectedValueOnce(new Error('cannot reach http://127.0.0.1:7891'))
      .mockResolvedValueOnce(undefined)

    const transition = service.transition(nextSettings)
    const queuedFetch = service.fetch('https://after.example')
    const error = await transition.catch((caught: unknown) => caught)
    await queuedFetch

    expect(error).toEqual({
      code: 'NETWORK_PROXY_APPLY_FAILED',
      message: 'The network proxy configuration could not be applied.',
    })
    expect(JSON.stringify(error)).not.toContain('127.0.0.1')
    expect(session.setProxy).toHaveBeenNthCalledWith(1, proxyConfigFor(nextSettings).electron)
    expect(session.setProxy).toHaveBeenNthCalledWith(2, proxyConfigFor(previousSettings).electron)
    expect(session.closeAllConnections).toHaveBeenCalledOnce()
    await expect(service.snapshot()).resolves.toEqual(proxyConfigFor(previousSettings).snapshot)
    expect(session.fetch).toHaveBeenCalledOnce()
  })

  it('restores the previous config and safe error when closing connections fails', async () => {
    const session = fakeSession()
    const service = new NetworkProxyService(session)
    const previousSettings = proxySettings(7890)
    const nextSettings = proxySettings(7891)
    await service.initialize(previousSettings)
    session.setProxy.mockClear()
    session.closeAllConnections.mockClear()
    session.closeAllConnections
      .mockRejectedValueOnce(new Error('close failed for http://127.0.0.1:7891'))
      .mockResolvedValueOnce(undefined)

    const error = await service.transition(nextSettings).catch((caught: unknown) => caught)

    expect(error).toEqual({
      code: 'NETWORK_PROXY_APPLY_FAILED',
      message: 'The network proxy configuration could not be applied.',
    })
    expect(JSON.stringify(error)).not.toContain('127.0.0.1')
    expect(session.setProxy).toHaveBeenNthCalledWith(1, proxyConfigFor(nextSettings).electron)
    expect(session.setProxy).toHaveBeenNthCalledWith(2, proxyConfigFor(previousSettings).electron)
    expect(session.closeAllConnections).toHaveBeenCalledTimes(2)
    await expect(service.snapshot()).resolves.toEqual(proxyConfigFor(previousSettings).snapshot)
  })

  it('enters a terminal unavailable state when rollback cannot restore enabled routing', async () => {
    const session = fakeSession()
    const service = new NetworkProxyService(session)
    const previousSettings = proxySettings(7890)
    await service.initialize(previousSettings)
    session.setProxy.mockClear()
    session.closeAllConnections.mockClear()
    session.setProxy
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('rollback http://127.0.0.1:7890 failed'))
    session.closeAllConnections
      .mockRejectedValueOnce(new Error('candidate direct cleanup failed'))
      .mockRejectedValueOnce(new Error('rollback close http://127.0.0.1:7890 failed'))

    const transition = service.transition(directSettings)
    const queuedFetch = service.fetch('https://after.example')
    const queuedSnapshot = service.snapshot()

    const safeError = {
      code: 'NETWORK_PROXY_APPLY_FAILED',
      message: 'The network proxy configuration could not be applied.',
    }
    await expect(transition).rejects.toEqual(safeError)
    await expect(queuedFetch).rejects.toEqual(safeError)
    await expect(queuedSnapshot).rejects.toEqual(safeError)
    await expect(service.fetch('https://future.example')).rejects.toEqual(safeError)
    await expect(service.snapshot()).rejects.toEqual(safeError)
    await expect(service.transition(previousSettings)).rejects.toEqual(safeError)
    const operation = vi.fn(async () => undefined)
    await expect(service.withTransportLease(operation)).rejects.toMatchObject({
      code: 'NETWORK_PROXY_APPLY_FAILED',
    })
    expect(operation).not.toHaveBeenCalled()

    expect(session.setProxy).toHaveBeenCalledTimes(2)
    expect(session.setProxy).toHaveBeenNthCalledWith(1, proxyConfigFor(directSettings).electron)
    expect(session.setProxy).toHaveBeenNthCalledWith(2, proxyConfigFor(previousSettings).electron)
    expect(session.closeAllConnections).toHaveBeenCalledTimes(2)
    expect(session.fetch).not.toHaveBeenCalled()
  })

  it('throws a safe error from initialization instead of silently downgrading', async () => {
    const session = fakeSession()
    session.setProxy.mockRejectedValueOnce(new Error('saved proxy 127.0.0.1:7890 failed'))
    const service = new NetworkProxyService(session)

    await expect(service.initialize(proxySettings(7890))).rejects.toEqual({
      code: 'NETWORK_PROXY_APPLY_FAILED',
      message: 'The network proxy configuration could not be applied.',
    })
    await expect(service.snapshot()).resolves.toEqual(proxyConfigFor(directSettings).snapshot)
  })
})
