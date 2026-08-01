import type { LookupAddress } from 'node:dns'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_SAFE_DOWNLOAD_BYTES,
  SafeMediaDownloader,
  type SafeMediaDownloaderDependencies,
} from './safe-download.js'

const PUBLIC_IPV4: LookupAddress = { address: '93.184.216.34', family: 4 }
const PUBLIC_IPV6: LookupAddress = { address: '2606:4700:4700::1111', family: 6 }
const SAFE_ERROR = {
  code: 'MEDIA_DOWNLOAD_FAILED',
  message: 'The media download failed.',
}

class ManualTimers {
  private nextHandle = 1
  readonly pending = new Map<number, { callback: () => void; milliseconds: number }>()

  readonly set = (callback: () => void, milliseconds: number): number => {
    const handle = this.nextHandle++
    this.pending.set(handle, { callback, milliseconds })
    return handle
  }

  readonly clear = (handle: unknown): void => {
    this.pending.delete(handle as number)
  }

  fire(milliseconds: number): void {
    const entry = [...this.pending.entries()].find(([, timer]) => timer.milliseconds === milliseconds)
    if (!entry) throw new Error(`No pending ${milliseconds} ms timer`)
    this.pending.delete(entry[0])
    entry[1].callback()
  }
}

interface FetchCall {
  input: string
  init: RequestInit
  resolve(response: Response): void
  reject(error: unknown): void
  responded: boolean
}

class ControlledBody {
  private controller!: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>
  readonly cancel = vi.fn()
  readonly stream: ReadableStream<Uint8Array<ArrayBuffer>>
  readCount = 0

  constructor() {
    this.stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start: (controller) => { this.controller = controller },
      pull: () => { this.readCount += 1 },
      cancel: (reason) => { this.cancel(reason) },
    }, { highWaterMark: 0 })
  }

  push(chunk: Buffer | string | null): void {
    if (this.destroyed) return
    if (chunk === null) this.controller.close()
    else this.controller.enqueue(Uint8Array.from(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
  }

  error(error: Error): void {
    this.controller.error(error)
  }

  get destroyed(): boolean {
    return this.cancel.mock.calls.length > 0
  }

  isPaused(): boolean {
    return true
  }

  emit(event: 'data' | 'end' | 'error' | 'aborted' | 'close', value?: Buffer | Error): void {
    if (event === 'data') this.push(value as Buffer)
    else if (event === 'end') this.push(null)
    else this.error(value instanceof Error ? value : new Error(`Response ${event}`))
  }

  eventNames(): Array<string | symbol> {
    return []
  }
}

class FakeFetch {
  readonly calls: FetchCall[] = []

  readonly fetch: SafeMediaDownloaderDependencies['fetch'] = (input, init) => (
    new Promise<Response>((resolve, reject) => {
      const call: FetchCall = { input, init, resolve, reject, responded: false }
      this.calls.push(call)
      init.signal?.addEventListener('abort', () => {
        if (!call.responded) reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    })
  )

  connect(index: number): void {
    if (!this.calls[index]) throw new Error(`No fetch call at index ${index}`)
  }

  respond(index: number, status: number, headers: HeadersInit = {}): ControlledBody {
    const call = this.calls[index]!
    const body = new ControlledBody()
    call.responded = true
    call.resolve(new Response(body.stream, { status, headers }))
    return body
  }

  respondWithoutBody(index: number, status = 204, headers: HeadersInit = {}): void {
    const call = this.calls[index]!
    call.responded = true
    call.resolve(new Response(null, { status, headers }))
  }

  respondMalformed(index: number, response: Partial<Response>): void {
    const call = this.calls[index]!
    call.responded = true
    call.resolve(response as Response)
  }

  respondWithRawHeaders(index: number, status: number, headers: Record<string, unknown>): ControlledBody {
    const body = new ControlledBody()
    this.respondMalformed(index, {
      status,
      headers: {
        get: (name: string) => headers[name.toLowerCase()] ?? null,
      } as unknown as Headers,
      body: body.stream,
    })
    return body
  }

  reject(index: number, error: Error): void {
    this.calls[index]!.reject(error)
  }
}

class RecordingSink extends Writable {
  readonly chunks: Buffer[] = []

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk))
    callback()
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

class BlockingSink extends Writable {
  readonly chunks: Buffer[] = []
  private releaseWrite?: (error?: Error | null) => void

  constructor() {
    super({ highWaterMark: 1 })
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk))
    this.releaseWrite = callback
  }

  release(): void {
    const callback = this.releaseWrite
    this.releaseWrite = undefined
    callback?.()
  }
}

class DeferredSink extends Writable {
  readonly chunks: Buffer[] = []
  private releaseWrite?: (error?: Error | null) => void

  constructor() {
    super({ autoDestroy: false })
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk))
    this.releaseWrite = callback
  }

  release(error?: Error): void {
    const callback = this.releaseWrite
    this.releaseWrite = undefined
    callback?.(error)
  }
}

function setup(
  answers: readonly LookupAddress[] = [PUBLIC_IPV4],
  overrides: Partial<SafeMediaDownloaderDependencies> = {},
) {
  const network = new FakeFetch()
  const timers = new ManualTimers()
  const resolveHost = vi.fn(async () => answers)
  const downloader = new SafeMediaDownloader({
    resolveHost,
    fetch: network.fetch,
    setTimer: timers.set,
    clearTimer: timers.clear,
    ...overrides,
  })
  return { downloader, network, resolveHost, timers }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (check()) return
    await Promise.resolve()
  }
  throw new Error('Expected asynchronous state was not reached')
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
}

async function expectSafeFailure(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toEqual(SAFE_ERROR)
}

describe('SafeMediaDownloader managed fetch transport', () => {
  it('streams a managed fetch response into the caller-owned destination', async () => {
    const fetch = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.close()
      },
    }), {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': '3' },
    }))
    const downloader = new SafeMediaDownloader({
      resolveHost: async () => [PUBLIC_IPV4],
      fetch,
    })
    const sink = new RecordingSink()

    await expect(downloader.download(
      'https://provider.example/result.png',
      sink,
      { maxBytes: 10, connectTimeoutMs: 1 },
    )).resolves.toEqual({ byteSize: 3, contentType: 'image/png' })
    expect(fetch).toHaveBeenCalledWith(
      'https://provider.example/result.png',
      expect.objectContaining({
        method: 'GET',
        redirect: 'manual',
        signal: expect.any(AbortSignal),
      }),
    )
    expect(sink.bytes()).toEqual(Buffer.from([1, 2, 3]))
  })

  it('revalidates redirects and rejects a private redirect before a second fetch', async () => {
    const resolveHost = vi.fn()
      .mockResolvedValueOnce([PUBLIC_IPV4])
      .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }])
    const { downloader, network } = setup([PUBLIC_IPV4], { resolveHost })
    const promise = downloader.download(
      'https://provider.example/start',
      new RecordingSink(),
      { maxBytes: 10 },
    )
    await waitFor(() => network.calls.length === 1)
    const redirect = network.respond(0, 307, { location: 'https://private.example/result' })

    await expectSafeFailure(promise)
    expect(resolveHost.mock.calls.map(([host]) => host)).toEqual([
      'provider.example',
      'private.example',
    ])
    expect(network.calls).toHaveLength(1)
    expect(redirect.cancel).toHaveBeenCalledOnce()
  })

  it.each([
    ['declared', '6', ['secret']],
    ['streamed', '5', ['123', '456']],
  ] as const)('cancels a %s oversized response without ending the destination', async (_kind, length, chunks) => {
    const { downloader, network } = setup()
    const sink = new RecordingSink()
    const promise = downloader.download(
      'https://provider.example/result.png',
      sink,
      { maxBytes: 5 },
    )
    await waitFor(() => network.calls.length === 1)
    const body = network.respond(0, 200, { 'content-length': length })
    for (const chunk of chunks) body.push(chunk)

    await expectSafeFailure(promise)
    expect(body.cancel).toHaveBeenCalledOnce()
    expect(sink.writableEnded).toBe(false)
    expect(sink.destroyed).toBe(false)
  })

  it('aborts and cancels the active body on total and first-byte timeouts', async () => {
    for (const failurePoint of ['total', 'first-byte'] as const) {
      const { downloader, network, timers } = setup()
      const promise = downloader.download(
        'https://provider.example/result.png',
        new RecordingSink(),
        { maxBytes: 10, firstByteTimeoutMs: 22, totalTimeoutMs: 33 },
      )
      await waitFor(() => network.calls.length === 1)
      const body = network.respond(0, 200)
      await waitFor(() => [...timers.pending.values()].some(
        ({ milliseconds }) => milliseconds === (failurePoint === 'total' ? 33 : 22),
      ))

      timers.fire(failurePoint === 'total' ? 33 : 22)

      await expectSafeFailure(promise)
      expect(network.calls[0]!.init.signal).toMatchObject({ aborted: true })
      expect(body.cancel).toHaveBeenCalledOnce()
      expect(timers.pending.size).toBe(0)
    }
  })

  it('waits for destination backpressure before reading the next response chunk', async () => {
    const { downloader, network } = setup()
    const sink = new BlockingSink()
    const promise = downloader.download(
      'https://provider.example/result.png',
      sink,
      { maxBytes: 10 },
    )
    await waitFor(() => network.calls.length === 1)
    const body = network.respond(0, 200)
    body.push('a')
    await waitFor(() => sink.chunks.length === 1)
    body.push('b')
    await flushMicrotasks()

    expect(sink.chunks.map(String)).toEqual(['a'])
    sink.release()
    await waitFor(() => sink.chunks.length === 2)
    body.push(null)
    sink.release()

    await expect(promise).resolves.toEqual({ byteSize: 2 })
    expect(sink.writableEnded).toBe(false)
  })

  it('aborts and cancels the reader when the destination write fails', async () => {
    const { downloader, network } = setup()
    const sink = new DeferredSink()
    const promise = downloader.download(
      'https://provider.example/result.png',
      sink,
      { maxBytes: 10 },
    )
    await waitFor(() => network.calls.length === 1)
    const body = network.respond(0, 200)
    body.push('part')
    await waitFor(() => sink.chunks.length === 1)

    sink.release(new Error('sensitive destination path'))

    await expectSafeFailure(promise)
    expect(network.calls[0]!.init.signal).toMatchObject({ aborted: true })
    expect(body.cancel).toHaveBeenCalledOnce()
    expect(sink.writableEnded).toBe(false)
  })

  it('aborts and cancels the reader when the caller-owned destination closes', async () => {
    const { downloader, network } = setup()
    const sink = new RecordingSink()
    const promise = downloader.download(
      'https://provider.example/result.png',
      sink,
      { maxBytes: 10 },
    )
    await waitFor(() => network.calls.length === 1)
    const body = network.respond(0, 200)

    sink.emit('close')

    await expectSafeFailure(promise)
    expect(network.calls[0]!.init.signal).toMatchObject({ aborted: true })
    expect(body.cancel).toHaveBeenCalledOnce()
  })

  it.each(['status', 'body'] as const)('rejects a malformed response %s and aborts the request', async (part) => {
    const { downloader, network } = setup()
    const promise = downloader.download(
      'https://provider.example/result.png',
      new RecordingSink(),
      { maxBytes: 10 },
    )
    await waitFor(() => network.calls.length === 1)
    const responseBody = new ControlledBody()
    network.respondMalformed(0, part === 'status'
      ? { status: Number.NaN, headers: new Headers(), body: responseBody.stream }
      : { status: 200, headers: new Headers(), body: {} as NonNullable<Response['body']> })

    await expectSafeFailure(promise)
    expect(network.calls[0]!.init.signal).toMatchObject({ aborted: true })
    if (part === 'status') expect(responseBody.cancel).toHaveBeenCalledOnce()
  })

  it('cancels and sanitizes a response-body read error', async () => {
    const { downloader, network } = setup()
    const promise = downloader.download(
      'https://secret-provider.example/result.png?token=secret',
      new RecordingSink(),
      { maxBytes: 10 },
    )
    await waitFor(() => network.calls.length === 1)
    const cancel = vi.fn(async () => undefined)
    network.respondMalformed(0, {
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: vi.fn().mockRejectedValue(new Error('secret body')),
          cancel,
        }),
      } as unknown as NonNullable<Response['body']>,
    })

    await expectSafeFailure(promise)
    expect(network.calls[0]!.init.signal).toMatchObject({ aborted: true })
    expect(cancel).toHaveBeenCalledOnce()
  })
})

describe('SafeMediaDownloader URL and address validation', () => {
  it.each([
    'http://provider.example/result.png',
    'https://user:password@provider.example/result.png',
    'https://provider.example:444/result.png',
    'https://provider.example./result.png',
    'https://PROVIDER.example/result.png',
    'https://provider.example/result.png#fragment',
    'https://intranet/result.png',
    'https://0x5db8d822/result.png',
    'https://93.184.216.34\\@127.0.0.1/result.png',
    ' https://provider.example/result.png',
  ])('rejects the non-canonical URL %s before DNS or HTTPS', async (url) => {
    const { downloader, network, resolveHost } = setup()

    await expectSafeFailure(downloader.download(url, new RecordingSink(), { maxBytes: 10 }))

    expect(resolveHost).not.toHaveBeenCalled()
    expect(network.calls).toHaveLength(0)
  })

  it.each([
    ['IPv4 unspecified', '0.0.0.0', 4],
    ['IPv4 private 10/8', '10.0.0.1', 4],
    ['IPv4 shared space', '100.64.0.1', 4],
    ['IPv4 loopback', '127.0.0.1', 4],
    ['IPv4 link-local', '169.254.1.1', 4],
    ['IPv4 private 172.16/12', '172.31.255.255', 4],
    ['IPv4 protocol assignments', '192.0.0.1', 4],
    ['IPv4 documentation 1', '192.0.2.1', 4],
    ['IPv4 AS112 special-purpose', '192.31.196.1', 4],
    ['IPv4 AMT special-purpose', '192.52.193.1', 4],
    ['IPv4 private 192.168/16', '192.168.1.1', 4],
    ['IPv4 direct-delegation special-purpose', '192.175.48.1', 4],
    ['IPv4 benchmarking', '198.18.0.1', 4],
    ['IPv4 documentation 2', '198.51.100.1', 4],
    ['IPv4 documentation 3', '203.0.113.1', 4],
    ['IPv4 multicast', '224.0.0.1', 4],
    ['IPv4 reserved', '240.0.0.1', 4],
    ['IPv4 broadcast', '255.255.255.255', 4],
    ['IPv6 unspecified', '::', 6],
    ['IPv6 loopback', '0:0:0:0:0:0:0:1', 6],
    ['IPv4-mapped private IPv6', '::ffff:127.0.0.1', 6],
    ['IPv4-mapped public IPv6', '0:0:0:0:0:ffff:5db8:d822', 6],
    ['IPv6 NAT64 translation', '64:ff9b::5db8:d822', 6],
    ['IPv6 discard-only', '100::1', 6],
    ['IPv6 special-purpose', '2001::1', 6],
    ['IPv6 documentation', '2001:db8::1', 6],
    ['IPv6 6to4', '2002:5db8:d822::1', 6],
    ['IPv6 documentation 3fff', '3fff::1', 6],
    ['IPv6 reserved global space', '4000::1', 6],
    ['IPv6 segment-routing special-purpose', '5f00::1', 6],
    ['IPv6 AS112 special-purpose', '2620:4f:8000::1', 6],
    ['IPv6 unique-local', 'fd00::1', 6],
    ['IPv6 link-local', 'fe80::1', 6],
    ['IPv6 deprecated site-local', 'fec0::1', 6],
    ['IPv6 multicast', 'ff02::1', 6],
  ])('rejects %s DNS answers', async (_name, address, family) => {
    const { downloader, network } = setup([{ address, family } as LookupAddress])
    const promise = downloader.download(
      'https://provider.example/result.png',
      new RecordingSink(),
      { maxBytes: 10 },
    )
    await flushMicrotasks()

    await expectSafeFailure(promise)

    expect(network.calls).toHaveLength(0)
  })

  it('rejects the complete DNS answer set when one answer is prohibited', async () => {
    const { downloader, network } = setup([
      PUBLIC_IPV4,
      { address: '127.0.0.1', family: 4 },
      PUBLIC_IPV6,
    ])

    await expectSafeFailure(downloader.download(
      'https://provider.example/result.png',
      new RecordingSink(),
      { maxBytes: 10 },
    ))

    expect(network.calls).toHaveLength(0)
  })

  it.each([
    ['unspecified', '::'],
    ['loopback', '::1'],
    ['IPv4-mapped start', '::ffff:0:0'],
    ['IPv4-mapped end', '::ffff:ffff:ffff'],
    ['well-known translation start', '64:ff9b::'],
    ['well-known translation end', '64:ff9b::ffff:ffff'],
    ['local translation start', '64:ff9b:1::'],
    ['local translation end', '64:ff9b:1:ffff:ffff:ffff:ffff:ffff'],
    ['discard-only start', '100::'],
    ['discard-only end', '100::ffff:ffff:ffff:ffff'],
    ['dummy prefix start', '100:0:0:1::'],
    ['dummy prefix end', '100:0:0:1:ffff:ffff:ffff:ffff'],
    ['IETF assignments start', '2001::'],
    ['IETF assignments end', '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['documentation start', '2001:db8::'],
    ['documentation end', '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['6to4 start', '2002::'],
    ['6to4 end', '2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['AS112 start', '2620:4f:8000::'],
    ['AS112 end', '2620:4f:8000:ffff:ffff:ffff:ffff:ffff'],
    ['documentation 3fff start', '3fff::'],
    ['documentation 3fff end', '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['segment-routing start', '5f00::'],
    ['segment-routing end', '5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['unique-local start', 'fc00::'],
    ['unique-local end', 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['link-local start', 'fe80::'],
    ['link-local end', 'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['deprecated site-local start', 'fec0::'],
    ['deprecated site-local end', 'feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['multicast start', 'ff00::'],
    ['multicast end', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ])('rejects the IPv6 special-registry boundary %s', async (_name, address) => {
    const { downloader, network } = setup([{ address, family: 6 }])
    const promise = downloader.download(
      'https://provider.example/result.png',
      new RecordingSink(),
      { maxBytes: 10 },
    )
    await flushMicrotasks()

    await expectSafeFailure(promise)
    expect(network.calls).toHaveLength(0)
  })

  it.each([
    ['before IETF assignments', '2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['after IETF assignments', '2001:200::1'],
    ['before documentation', '2001:db7:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['after documentation', '2001:db9::1'],
    ['before 6to4', '2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['after 6to4', '2003::1'],
    ['before AS112', '2620:4f:7fff:ffff:ffff:ffff:ffff:ffff'],
    ['after AS112', '2620:4f:8001::1'],
    ['before 3fff documentation', '3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['after 3fff documentation', '3fff:1000::1'],
  ])('accepts the adjacent global-unicast address %s', async (_name, address) => {
    const { downloader, network } = setup([{ address, family: 6 }])
    const promise = downloader.download(
      'https://provider.example/result.png',
      new RecordingSink(),
      { maxBytes: 10 },
    )
    await waitFor(() => network.calls.length === 1)
    network.connect(0)
    const response = network.respond(0, 200, { 'content-length': '0' })
    response.push(null)

    await expect(promise).resolves.toEqual({ byteSize: 0 })
  })

  it('rejects a mixed DNS set containing a local translation address', async () => {
    const { downloader, network } = setup([
      PUBLIC_IPV4,
      { address: '64:ff9b:1::a00:1', family: 6 },
      PUBLIC_IPV6,
    ])

    await expectSafeFailure(downloader.download(
      'https://provider.example/result.png',
      new RecordingSink(),
      { maxBytes: 10 },
    ))
    expect(network.calls).toHaveLength(0)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_SAFE_DOWNLOAD_BYTES + 1])(
    'rejects invalid or unbounded maxBytes %s before DNS',
    async (maxBytes) => {
      const { downloader, resolveHost } = setup()

      await expectSafeFailure(downloader.download(
        'https://provider.example/result.png',
        new RecordingSink(),
        { maxBytes },
      ))

      expect(resolveHost).not.toHaveBeenCalled()
    },
  )

  it('validates the complete DNS answer set before invoking managed fetch', async () => {
    const { downloader, network, resolveHost } = setup([PUBLIC_IPV4, PUBLIC_IPV6])
    const sink = new RecordingSink()
    const promise = downloader.download(
      'https://provider.example/result.png',
      sink,
      { maxBytes: 10 },
    )
    await waitFor(() => network.calls.length === 1)
    expect(resolveHost).toHaveBeenCalledWith('provider.example')
    expect(network.calls[0]).toMatchObject({
      input: 'https://provider.example/result.png',
      init: { method: 'GET', redirect: 'manual' },
    })
    const response = network.respond(0, 200)
    response.push(null)
    await expect(promise).resolves.toEqual({ byteSize: 0 })
  })
})

describe('SafeMediaDownloader redirects and responses', () => {
  it('revalidates every redirect and allows at most three redirects', async () => {
    const answers = new Map([
      ['one.example', [PUBLIC_IPV4]],
      ['two.example', [PUBLIC_IPV6]],
      ['three.example', [PUBLIC_IPV4]],
      ['four.example', [PUBLIC_IPV6]],
    ])
    const resolveHost = vi.fn(async (host: string) => answers.get(host) ?? [])
    const { downloader, network } = setup([PUBLIC_IPV4], { resolveHost })
    const sink = new RecordingSink()
    const promise = downloader.download(
      'https://one.example/start',
      sink,
      { maxBytes: 10 },
    )

    for (const [index, location] of [
      'https://two.example/next',
      'https://three.example/next',
      'https://four.example/final',
    ].entries()) {
      await waitFor(() => network.calls.length === index + 1)
      network.connect(index)
      const response = network.respond(index, 302, { location })
      response.push('redirect body')
      await waitFor(() => response.destroyed)
      expect(response.destroyed).toBe(true)
    }

    await waitFor(() => network.calls.length === 4)
    network.connect(3)
    const final = network.respond(3, 200, { 'content-type': ' Image/PNG ; charset=binary ' })
    final.push('done')
    final.push(null)

    await expect(promise).resolves.toEqual({ byteSize: 4, contentType: 'image/png' })
    expect(resolveHost.mock.calls.map(([host]) => host)).toEqual([
      'one.example',
      'two.example',
      'three.example',
      'four.example',
    ])
    expect(sink.bytes().toString()).toBe('done')
  })

  it('cancels the fourth redirect response and never resolves a fifth host', async () => {
    const { downloader, network, resolveHost } = setup()
    const promise = downloader.download(
      'https://provider.example/start',
      new RecordingSink(),
      { maxBytes: 10 },
    )
    let fourthResponse: ControlledBody | undefined

    for (let index = 0; index < 4; index += 1) {
      await waitFor(() => network.calls.length === index + 1)
      network.connect(index)
      const response = network.respond(index, 302, { location: `/redirect-${index}` })
      response.push('untrusted redirect body')
      if (index === 3) fourthResponse = response
    }

    await expectSafeFailure(promise)
    expect(fourthResponse?.destroyed).toBe(true)
    expect(resolveHost).toHaveBeenCalledTimes(4)
    expect(network.calls).toHaveLength(4)
  })

  it('cancels a redirect before rejecting its newly resolved private host', async () => {
    const resolveHost = vi.fn()
      .mockResolvedValueOnce([PUBLIC_IPV4])
      .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }])
    const { downloader, network } = setup([PUBLIC_IPV4], { resolveHost })
    const promise = downloader.download(
      'https://provider.example/start',
      new RecordingSink(),
      { maxBytes: 10 },
    )
    await waitFor(() => network.calls.length === 1)
    network.connect(0)
    const redirect = network.respond(0, 307, { location: 'https://private.example/result' })
    redirect.push('body')

    await expectSafeFailure(promise)
    expect(redirect.destroyed).toBe(true)
    expect(resolveHost).toHaveBeenCalledTimes(2)
    expect(network.calls).toHaveLength(1)
  })

  it('rejects non-2xx responses and cancels their bodies', async () => {
    const { downloader, network } = setup()
    const promise = downloader.download(
      'https://provider.example/result.png',
      new RecordingSink(),
      { maxBytes: 10 },
    )
    await waitFor(() => network.calls.length === 1)
    network.connect(0)
    const response = network.respond(0, 500)
    response.push('sensitive provider error')

    await expectSafeFailure(promise)
    expect(network.calls[0]!.init.signal).toMatchObject({ aborted: true })
  })

  it('prechecks Content-Length and does not write an oversized body', async () => {
    const { downloader, network } = setup()
    const sink = new RecordingSink()
    const promise = downloader.download(
      'https://provider.example/result.png',
      sink,
      { maxBytes: 5 },
    )
    await waitFor(() => network.calls.length === 1)
    network.connect(0)
    const response = network.respond(0, 200, { 'content-length': '6' })
    response.push('secret')

    await expectSafeFailure(promise)
    expect(sink.bytes()).toHaveLength(0)
    expect(response.destroyed).toBe(true)
  })

  it('enforces actual streamed bytes when Content-Length is misleading', async () => {
    const { downloader, network } = setup()
    const sink = new RecordingSink()
    const promise = downloader.download(
      'https://provider.example/result.png',
      sink,
      { maxBytes: 5 },
    )
    await waitFor(() => network.calls.length === 1)
    network.connect(0)
    const response = network.respond(0, 200, { 'content-length': '5' })
    response.push('123')
    response.push('456')

    await expectSafeFailure(promise)
    expect(sink.bytes().toString()).toBe('123')
    expect(response.destroyed).toBe(true)
    expect(sink.destroyed).toBe(false)
    expect(sink.writableEnded).toBe(false)
  })

  it('rejects a body longer than its declared Content-Length while still below maxBytes', async () => {
    const { downloader, network, timers } = setup()
    const sink = new RecordingSink()
    const promise = downloader.download(
      'https://provider.example/result.png',
      sink,
      { maxBytes: 10 },
    )
    await waitFor(() => network.calls.length === 1)
    network.connect(0)
    const response = network.respond(0, 200, { 'content-length': '2' })
    response.push('ab')
    response.push('c')
    response.push(null)

    await expectSafeFailure(promise)
    expect(network.calls[0]!.init.signal).toMatchObject({ aborted: true })
    expect(timers.pending.size).toBe(0)
    expect(sink.writableEnded).toBe(false)
  })

  it('rejects a body shorter than its declared Content-Length at end', async () => {
    const { downloader, network, timers } = setup()
    const sink = new RecordingSink()
    const promise = downloader.download(
      'https://provider.example/result.png',
      sink,
      { maxBytes: 10 },
    )
    await waitFor(() => network.calls.length === 1)
    network.connect(0)
    const response = network.respond(0, 200, { 'content-length': '4' })
    response.push('abc')
    response.push(null)

    await expectSafeFailure(promise)
    expect(network.calls[0]!.init.signal).toMatchObject({ aborted: true })
    expect(timers.pending.size).toBe(0)
    expect(sink.bytes().toString()).toBe('abc')
    expect(sink.writableEnded).toBe(false)
  })

  it.each([
    ['comma-separated values', '2, 2'],
    ['duplicate array values', ['2', '2']],
    ['leading zero', '02'],
    ['positive sign', '+2'],
    ['decimal syntax', '2.0'],
    ['surrounding whitespace', ' 2 '],
    ['unsafe integer', '9007199254740992'],
  ] as const)('rejects invalid Content-Length %s', async (_name, value) => {
    const { downloader, network } = setup()
    const sink = new RecordingSink()
    const promise = downloader.download(
      'https://provider.example/result.png',
      sink,
      { maxBytes: 10 },
    )
    await waitFor(() => network.calls.length === 1)
    network.connect(0)
    const response = network.respondWithRawHeaders(0, 200, { 'content-length': value })

    await expectSafeFailure(promise)
    expect(response.destroyed).toBe(true)
    expect(sink.bytes()).toHaveLength(0)
  })

  it.each([
    ['zero bytes', '0', '', 0],
    ['nonzero bytes', '2', 'ok', 2],
  ] as const)('accepts exact %s Content-Length', async (_name, declared, body, byteSize) => {
    const { downloader, network } = setup()
    const sink = new RecordingSink()
    const promise = downloader.download(
      'https://provider.example/result.png',
      sink,
      { maxBytes: 10 },
    )
    await waitFor(() => network.calls.length === 1)
    network.connect(0)
    const response = network.respond(0, 200, { 'content-length': declared })
    if (body) response.push(body)
    response.push(null)

    await expect(promise).resolves.toEqual({ byteSize })
    expect(sink.bytes().toString()).toBe(body)
    expect(sink.writableEnded).toBe(false)
  })

  it('does not carry a redirect Content-Length into the final response', async () => {
    const { downloader, network } = setup()
    const sink = new RecordingSink()
    const promise = downloader.download(
      'https://provider.example/start',
      sink,
      { maxBytes: 10 },
    )
    await waitFor(() => network.calls.length === 1)
    network.connect(0)
    const redirect = network.respond(0, 302, {
      location: '/final',
      'content-length': '999',
    })
    await waitFor(() => redirect.destroyed)
    expect(redirect.destroyed).toBe(true)
    await waitFor(() => network.calls.length === 2)
    network.connect(1)
    const final = network.respond(1, 200, { 'content-length': '2' })
    final.push('ok')
    final.push(null)

    await expect(promise).resolves.toEqual({ byteSize: 2 })
    expect(sink.bytes().toString()).toBe('ok')
  })

  it('streams with backpressure and does not end the caller-owned destination', async () => {
    const { downloader, network } = setup()
    const sink = new BlockingSink()
    const promise = downloader.download(
      'https://provider.example/result.png',
      sink,
      { maxBytes: 10 },
    )
    await waitFor(() => network.calls.length === 1)
    network.connect(0)
    const response = network.respond(0, 200)
    response.emit('data', Buffer.from('a'))

    await waitFor(() => sink.chunks.length === 1)
    expect(sink.chunks.map(String)).toEqual(['a'])
    expect(response.isPaused()).toBe(true)
    sink.release()
    await new Promise<void>((resolve) => setImmediate(resolve))
    response.emit('data', Buffer.from('b'))
    response.emit('end')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(sink.chunks.map(String)).toEqual(['a', 'b'])
    sink.release()

    await expect(promise).resolves.toEqual({ byteSize: 2 })
    expect(sink.writableEnded).toBe(false)
    expect(sink.destroyed).toBe(false)
  })

  it('does not resolve before an accepted asynchronous destination write completes', async () => {
    const { downloader, network } = setup()
    const sink = new DeferredSink()
    let resolved = false
    const promise = downloader.download(
      'https://provider.example/result.png',
      sink,
      { maxBytes: 10 },
    ).then((result) => {
      resolved = true
      return result
    })
    await waitFor(() => network.calls.length === 1)
    network.connect(0)
    const response = network.respond(0, 200)
    response.emit('data', Buffer.from('ok'))
    response.emit('end')
    await flushMicrotasks()

    expect(resolved).toBe(false)
    sink.release()

    await expect(promise).resolves.toEqual({ byteSize: 2 })
  })

  it('rejects an asynchronous destination write failure before reporting success', async () => {
    const { downloader, network } = setup()
    const sink = new DeferredSink()
    const promise = downloader.download(
      'https://provider.example/result.png',
      sink,
      { maxBytes: 10 },
    )
    await waitFor(() => network.calls.length === 1)
    network.connect(0)
    const response = network.respond(0, 200)
    response.emit('data', Buffer.from('ok'))
    response.emit('end')
    await waitFor(() => sink.chunks.length === 1)

    sink.release(new Error('sensitive destination path'))

    await expectSafeFailure(promise)
    expect(sink.writableEnded).toBe(false)
  })
})

describe('SafeMediaDownloader failure lifecycle', () => {
  it('rejects connect, first-byte, and total timeouts and aborts the active request', async () => {
    for (const timeout of [
      { milliseconds: 11, headersReceived: false },
      { milliseconds: 22, headersReceived: true },
      { milliseconds: 33, headersReceived: true },
    ]) {
      const { downloader, network, timers } = setup()
      const promise = downloader.download(
        'https://provider.example/result.png',
        new RecordingSink(),
        {
          maxBytes: 10,
          connectTimeoutMs: 11,
          firstByteTimeoutMs: 22,
          totalTimeoutMs: 33,
        },
      )
      await waitFor(() => network.calls.length === 1)
      const response = timeout.headersReceived ? network.respond(0, 200) : undefined
      await waitFor(() => [...timers.pending.values()].some(
        ({ milliseconds }) => milliseconds === timeout.milliseconds,
      ))

      timers.fire(timeout.milliseconds)

      await expectSafeFailure(promise)
      expect(network.calls[0]!.init.signal).toMatchObject({ aborted: true })
      if (response) expect(response.destroyed).toBe(true)
      expect(timers.pending.size).toBe(0)
    }
  })

  it('prevents a request from starting when total timeout wins during DNS', async () => {
    let finishResolution!: (answers: LookupAddress[]) => void
    const resolveHost = vi.fn(() => new Promise<LookupAddress[]>((resolve) => {
      finishResolution = resolve
    }))
    const { downloader, network, timers } = setup([PUBLIC_IPV4], { resolveHost })
    const promise = downloader.download(
      'https://provider.example/result.png',
      new RecordingSink(),
      { maxBytes: 10, totalTimeoutMs: 33 },
    )
    await waitFor(() => resolveHost.mock.calls.length === 1)

    timers.fire(33)
    await expectSafeFailure(promise)
    finishResolution([PUBLIC_IPV4])
    await Promise.resolve()
    await Promise.resolve()

    expect(network.calls).toHaveLength(0)
    expect(timers.pending.size).toBe(0)
  })

  it.each(['total timeout', 'response abort'] as const)(
    'retains a destination error guard until a deferred write settles after %s',
    async (failurePoint) => {
      const { downloader, network, timers } = setup()
      const sink = new DeferredSink()
      const baselineErrorListeners = sink.listenerCount('error')
      const baselineCloseListeners = sink.listenerCount('close')
      const promise = downloader.download(
        'https://provider.example/result.png',
        sink,
        { maxBytes: 10, totalTimeoutMs: 33 },
      )
      await waitFor(() => network.calls.length === 1)
      network.connect(0)
      const response = network.respond(0, 200)
      response.emit('data', Buffer.from('pending'))
      await waitFor(() => sink.chunks.length === 1)

      if (failurePoint === 'total timeout') timers.fire(33)
      else response.emit('aborted', new Error('response aborted'))

      // Failure remains prompt and does not wait for the caller-owned sink.
      await expectSafeFailure(promise)
      expect(timers.pending.size).toBe(0)
      expect(network.calls[0]!.init.signal).toMatchObject({ aborted: true })
      expect(network.calls[0]!.init.signal).toMatchObject({ aborted: true })
      expect(sink.listenerCount('error')).toBe(baselineErrorListeners + 1)
      expect(sink.listenerCount('close')).toBe(baselineCloseListeners)
      expect(sink.writableEnded).toBe(false)
      expect(sink.destroyed).toBe(false)

      sink.release(new Error('late deferred destination failure'))
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(sink.listenerCount('error')).toBe(baselineErrorListeners)
      expect(sink.listenerCount('close')).toBe(baselineCloseListeners)
      expect(timers.pending.size).toBe(0)
      expect(sink.writableEnded).toBe(false)
      expect(sink.destroyed).toBe(false)
    },
  )

  it.each(['request error', 'response error', 'response aborted'] as const)(
    'sanitizes %s without leaking the URL, host, or underlying message',
    async (failurePoint) => {
      const { downloader, network } = setup()
      const promise = downloader.download(
        'https://secret-provider.example/result.png?token=secret',
        new RecordingSink(),
        { maxBytes: 10 },
      )
      await waitFor(() => network.calls.length === 1)
      network.connect(0)
      if (failurePoint === 'request error') {
        network.reject(0, new Error('secret-provider.example token=secret'))
      } else {
        const response = network.respond(0, 200)
        response.emit(failurePoint === 'response error' ? 'error' : 'aborted', new Error('secret body'))
      }

      await expectSafeFailure(promise)
    },
  )

  it.each(['error', 'close'] as const)('rejects destination %s and leaves it caller-owned', async (event) => {
    const { downloader, network } = setup()
    const sink = new RecordingSink()
    const promise = downloader.download(
      'https://provider.example/result.png',
      sink,
      { maxBytes: 10 },
    )
    await waitFor(() => network.calls.length === 1)
    network.connect(0)
    const response = network.respond(0, 200)
    response.push('part')

    if (event === 'error') sink.emit('error', new Error('disk path secret'))
    else sink.emit('close')

    await expectSafeFailure(promise)
    expect(network.calls[0]!.init.signal).toMatchObject({ aborted: true })
    expect(response.destroyed).toBe(true)
    expect(sink.writableEnded).toBe(false)
  })

  it('cleans request, response, destination, and timer listeners after success', async () => {
    const { downloader, network, timers } = setup()
    const sink = new RecordingSink()
    const errorListeners = sink.listenerCount('error')
    const closeListeners = sink.listenerCount('close')
    const promise = downloader.download(
      'https://provider.example/result.png',
      sink,
      { maxBytes: 10 },
    )
    await waitFor(() => network.calls.length === 1)
    network.connect(0)
    const response = network.respond(0, 200)
    response.push('ok')
    response.push(null)

    await expect(promise).resolves.toEqual({ byteSize: 2 })
    expect(timers.pending.size).toBe(0)
    expect(network.calls[0]!.init.signal).toMatchObject({ aborted: false })
    expect(response.eventNames()).toEqual([])
    expect(sink.listenerCount('error')).toBe(errorListeners)
    expect(sink.listenerCount('close')).toBe(closeListeners)
  })
})
