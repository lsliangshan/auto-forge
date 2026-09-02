import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireLockedArtifacts,
  acquireVerifiedArchive,
} from '../../scripts/converter-packs/acquire-sources.mjs'
import { canonicalBytes } from '../../scripts/converter-packs/pack-tooling-lib.mjs'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autoforge-acquisition-')))
  temporaryRoots.push(root)
  return root
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function acquisition(bytes: Buffer, name: string) {
  return {
    kind: 'homebrew-bottle',
    url: `https://downloads.example.test/${name}.tar.gz`,
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
    cellar: '/opt/homebrew/Cellar',
  }
}

function writePartial(cacheRoot: string, archive: { url: string; sha256: string; bytes: number }, bytes: Buffer, partialBytes = bytes.byteLength) {
  writeFileSync(join(cacheRoot, `.${archive.sha256}.partial`), bytes, { mode: 0o600 })
  writeFileSync(join(cacheRoot, `.${archive.sha256}.partial.json`), canonicalBytes({
    bytes: archive.bytes,
    partialBytes,
    sha256: archive.sha256,
    url: archive.url,
  }), { mode: 0o600 })
}

describe('converter pack source acquisition', () => {
  it('resumes an exact partial with a matching byte range', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('0123456789')
    const archive = {
      url: 'https://downloads.example.test/engine.tar.xz',
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    }
    writeFileSync(join(cacheRoot, `.${archive.sha256}.partial`), bytes.subarray(0, 4), { mode: 0o600 })
    writeFileSync(join(cacheRoot, `.${archive.sha256}.partial.json`), canonicalBytes({
      bytes: archive.bytes,
      partialBytes: 4,
      sha256: archive.sha256,
      url: archive.url,
    }), { mode: 0o600 })
    const requests: Array<{ range: string | null; signal: AbortSignal | null }> = []

    const result = await acquireVerifiedArchive({
      archive,
      cacheRoot,
      fetchImpl: async (_input, init) => {
        requests.push({
          range: new Headers(init?.headers).get('range'),
          signal: init?.signal ?? null,
        })
        return new Response(bytes.subarray(4), {
          status: 206,
          headers: {
            'content-length': '6',
            'content-range': 'bytes 4-9/10',
          },
        })
      },
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.range).toBe('bytes=4-')
    expect(requests[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(readFileSync(result.path)).toEqual(bytes)
    expect(result.networkBytes).toBe(6)
    expect(readdirSync(cacheRoot)).toEqual([`${archive.sha256}.archive`])
  })

  it('restarts from byte zero when a ranged request receives a complete 200 response', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('0123456789')
    const archive = { url: 'https://downloads.example.test/restart.tar.gz', sha256: sha256(bytes), bytes: 10 }
    writePartial(cacheRoot, archive, Buffer.from('host'))
    let range: string | null = null

    const result = await acquireVerifiedArchive({
      archive,
      cacheRoot,
      fetchImpl: async (_input, init) => {
        range = new Headers(init?.headers).get('range')
        return new Response(bytes, { status: 200, headers: { 'content-length': '10' } })
      },
    })

    expect(range).toBe('bytes=4-')
    expect(result.networkBytes).toBe(10)
    expect(readFileSync(result.path)).toEqual(bytes)
    expect(readdirSync(cacheRoot)).toEqual([`${archive.sha256}.archive`])
  })

  it.each([
    ['missing range', null, '6'],
    ['shifted start', 'bytes 3-9/10', '7'],
    ['oversized end', 'bytes 4-10/10', '7'],
    ['wrong total', 'bytes 4-9/11', '6'],
    ['wrong response length', 'bytes 4-9/10', '5'],
  ])('discards a bound partial after a malformed 206: %s', async (_label, contentRange, contentLength) => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('0123456789')
    const archive = { url: 'https://downloads.example.test/range.tar.gz', sha256: sha256(bytes), bytes: 10 }
    writePartial(cacheRoot, archive, bytes.subarray(0, 4))
    const headers = new Headers({ 'content-length': contentLength })
    if (contentRange !== null) headers.set('content-range', contentRange)

    await expect(acquireVerifiedArchive({
      archive,
      cacheRoot,
      fetchImpl: async () => new Response(bytes.subarray(4), { status: 206, headers }),
    })).rejects.toThrow('Converter source download failed.')
    expect(readdirSync(cacheRoot)).toEqual([])
  })

  it('discards a partial when a restart response declares only the missing suffix', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('0123456789')
    const archive = { url: 'https://downloads.example.test/restart-length.tar.gz', sha256: sha256(bytes), bytes: 10 }
    writePartial(cacheRoot, archive, bytes.subarray(0, 4))

    await expect(acquireVerifiedArchive({
      archive,
      cacheRoot,
      fetchImpl: async () => new Response(bytes.subarray(4), {
        status: 200,
        headers: { 'content-length': '6' },
      }),
    })).rejects.toThrow('Converter source download failed.')
    expect(readdirSync(cacheRoot)).toEqual([])
  })

  it.each([
    ['URL', (value: { url: string; sha256: string; bytes: number; partialBytes: number }) => { value.url = 'https://downloads.example.test/stale.tar.gz' }],
    ['SHA', (value: { url: string; sha256: string; bytes: number; partialBytes: number }) => { value.sha256 = '0'.repeat(64) }],
    ['size', (value: { url: string; sha256: string; bytes: number; partialBytes: number }) => { value.bytes += 1 }],
  ])('rejects and removes stale metadata with a mismatched %s binding', async (_label, mutate) => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('0123456789')
    const archive = { url: 'https://downloads.example.test/current.tar.gz', sha256: sha256(bytes), bytes: 10 }
    writeFileSync(join(cacheRoot, `.${archive.sha256}.partial`), bytes.subarray(0, 4), { mode: 0o600 })
    const metadata = { ...archive, partialBytes: 4 }
    mutate(metadata)
    writeFileSync(join(cacheRoot, `.${archive.sha256}.partial.json`), canonicalBytes(metadata), { mode: 0o600 })
    let requests = 0

    await expect(acquireVerifiedArchive({
      archive,
      cacheRoot,
      fetchImpl: async () => {
        requests += 1
        return new Response(bytes, { status: 200 })
      },
    })).rejects.toThrow('Converter source partial cache is invalid.')
    expect(requests).toBe(0)
    expect(readdirSync(cacheRoot)).toEqual([])
  })

  it('rejects a symlink partial without changing its external target', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('0123456789')
    const archive = { url: 'https://downloads.example.test/symlink.tar.gz', sha256: sha256(bytes), bytes: 10 }
    const external = join(root, 'external')
    writeFileSync(external, 'outside', { mode: 0o600 })
    const partialPath = join(cacheRoot, `.${archive.sha256}.partial`)
    symlinkSync(external, partialPath)
    writeFileSync(join(cacheRoot, `.${archive.sha256}.partial.json`), canonicalBytes({
      bytes: archive.bytes, partialBytes: 4, sha256: archive.sha256, url: archive.url,
    }), { mode: 0o600 })

    await expect(acquireVerifiedArchive({ archive, cacheRoot, fetchImpl: async () => new Response(bytes) }))
      .rejects.toThrow('Converter source partial cache is invalid.')
    expect(readFileSync(external, 'utf8')).toBe('outside')
    expect(readdirSync(cacheRoot)).toEqual([])
  })

  it('rehashes a complete partial before publication and removes it on mismatch', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const expected = Buffer.from('expected')
    const archive = { url: 'https://downloads.example.test/full-partial.tar.gz', sha256: sha256(expected), bytes: expected.byteLength }
    writePartial(cacheRoot, archive, Buffer.from('hostile!'))
    let requests = 0

    await expect(acquireVerifiedArchive({
      archive,
      cacheRoot,
      fetchImpl: async () => {
        requests += 1
        return new Response(expected)
      },
    })).rejects.toThrow('Downloaded converter archive hash does not match the source lock.')
    expect(requests).toBe(0)
    expect(readdirSync(cacheRoot)).toEqual([])
  })

  it('stores verified response bytes once and reuses the immutable cache entry', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('verified converter archive bytes')
    let requests = 0
    const fetchImpl: typeof fetch = async () => {
      requests += 1
      if (requests > 1) throw new Error('cache miss caused an unexpected network request')
      return new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) },
      })
    }
    const archive = {
      url: 'https://downloads.example.test/engine.tar.xz',
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    }

    const first = await acquireVerifiedArchive({ archive, cacheRoot, fetchImpl })
    const second = await acquireVerifiedArchive({ archive, cacheRoot, fetchImpl })

    expect(first).toEqual({
      path: join(cacheRoot, `${archive.sha256}.archive`),
      sha256: archive.sha256,
      bytes: 32,
      networkBytes: 32,
    })
    expect(second).toEqual({ ...first, networkBytes: 0 })
    expect(readFileSync(first.path)).toEqual(bytes)
    expect(lstatSync(first.path).isFile()).toBe(true)
    expect(lstatSync(first.path).mode & 0o077).toBe(0)
    expect(requests).toBe(1)
  })

  it('rejects a corrupted existing cache entry instead of replacing or trusting it', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const expected = Buffer.from('expected archive')
    const digest = sha256(expected)
    const cachePath = join(cacheRoot, `${digest}.archive`)
    writeFileSync(cachePath, 'corrupted cache entry', { mode: 0o600 })
    let requests = 0

    await expect(acquireVerifiedArchive({
      archive: { url: 'https://downloads.example.test/engine.tar.xz', sha256: digest, bytes: expected.byteLength },
      cacheRoot,
      fetchImpl: async () => {
        requests += 1
        return new Response(expected, { status: 200 })
      },
    })).rejects.toThrow('Cached converter archive size does not match the source lock.')
    expect(readFileSync(cachePath, 'utf8')).toBe('corrupted cache entry')
    expect(requests).toBe(0)
  })

  it('rejects hash-mismatched bytes without occupying the immutable cache key', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const expected = Buffer.from('expected archive')
    const received = Buffer.alloc(expected.byteLength, 'x')

    await expect(acquireVerifiedArchive({
      archive: {
        url: 'https://downloads.example.test/engine.tar.xz',
        sha256: sha256(expected),
        bytes: expected.byteLength,
      },
      cacheRoot,
      fetchImpl: async () => new Response(received, { status: 200 }),
    })).rejects.toThrow('Downloaded converter archive hash does not match the source lock.')
    expect(readdirSync(cacheRoot)).toEqual([])
  })

  it('rejects a response whose declared length exceeds the locked byte length', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('12345')

    await expect(acquireVerifiedArchive({
      archive: {
        url: 'https://downloads.example.test/engine.tar.xz',
        sha256: sha256(bytes),
        bytes: 4,
      },
      cacheRoot,
      fetchImpl: async () => new Response(bytes, {
        status: 200,
        headers: { 'content-length': '5' },
      }),
    })).rejects.toThrow('Converter source download failed.')
    expect(readdirSync(cacheRoot)).toEqual([])
  })

  it('enforces the locked byte length while streaming when content-length is absent', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('12345')

    await expect(acquireVerifiedArchive({
      archive: {
        url: 'https://downloads.example.test/engine.tar.xz',
        sha256: sha256(bytes),
        bytes: 4,
      },
      cacheRoot,
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      }), { status: 200 }),
    })).rejects.toThrow('Converter source download failed.')
    expect(readdirSync(cacheRoot)).toEqual([])
  })

  it('rejects a non-HTTPS archive URL before making a network request', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('archive')
    let requests = 0

    await expect(acquireVerifiedArchive({
      archive: {
        url: 'http://downloads.example.test/engine.tar.xz',
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
      },
      cacheRoot,
      fetchImpl: async () => {
        requests += 1
        return new Response(bytes, { status: 200 })
      },
    })).rejects.toThrow('Converter source archive identity is invalid.')
    expect(requests).toBe(0)
    expect(readdirSync(cacheRoot)).toEqual([])
  })

  it('rejects an unsuccessful HTTP response even when its body matches the lock hash', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('archive')

    await expect(acquireVerifiedArchive({
      archive: {
        url: 'https://downloads.example.test/engine.tar.xz',
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
      },
      cacheRoot,
      fetchImpl: async () => new Response(bytes, { status: 503 }),
    })).rejects.toThrow('Converter source download failed.')
    expect(readdirSync(cacheRoot)).toEqual([])
  })

  it('cancels the response reader when status validation rejects the transfer', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('archive')
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() { cancelled = true },
    })

    await expect(acquireVerifiedArchive({
      archive: {
        url: 'https://downloads.example.test/engine.tar.xz',
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
      },
      cacheRoot,
      fetchImpl: async () => new Response(body, { status: 503 }),
    })).rejects.toThrow('Converter source download failed.')
    expect(cancelled).toBe(true)
  })

  it('rejects a redirect that terminates on a non-HTTPS URL', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('archive')
    const response = new Response(bytes, { status: 200 })
    Object.defineProperty(response, 'url', { value: 'http://mirror.example.test/engine.tar.xz' })

    await expect(acquireVerifiedArchive({
      archive: {
        url: 'https://downloads.example.test/engine.tar.xz',
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
      },
      cacheRoot,
      fetchImpl: async () => response,
    })).rejects.toThrow('Converter source download failed.')
    expect(readdirSync(cacheRoot)).toEqual([])
  })

  it('completes the anonymous GHCR bearer challenge before streaming a pinned bottle', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('homebrew bottle bytes')
    const archiveUrl = `https://ghcr.io/v2/homebrew/core/ffmpeg/blobs/sha256:${sha256(bytes)}`
    const archive = { url: archiveUrl, sha256: sha256(bytes), bytes: bytes.byteLength }
    writePartial(cacheRoot, archive, bytes.subarray(0, 4))
    const requests: Array<{ url: string; range: string | null; authorization: string | null; signal: AbortSignal | null }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      const authorization = headers.get('authorization')
      requests.push({ url, range: headers.get('range'), authorization, signal: init?.signal ?? null })
      if (url === archiveUrl && authorization === null) {
        return new Response('{}', {
          status: 401,
          headers: {
            'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:homebrew/core/ffmpeg:pull"',
          },
        })
      }
      if (url === 'https://ghcr.io/token?service=ghcr.io&scope=repository%3Ahomebrew%2Fcore%2Fffmpeg%3Apull') {
        return Response.json({ token: 'fixture-token' })
      }
      if (url === archiveUrl && authorization === 'Bearer fixture-token') {
        return new Response(bytes.subarray(4), {
          status: 206,
          headers: {
            'content-length': String(bytes.byteLength - 4),
            'content-range': `bytes 4-${bytes.byteLength - 1}/${bytes.byteLength}`,
          },
        })
      }
      return new Response('unexpected request', { status: 500 })
    }

    const result = await acquireVerifiedArchive({
      archive,
      cacheRoot,
      fetchImpl,
    })

    expect(readFileSync(result.path)).toEqual(bytes)
    expect(result.sha256).toBe(sha256(bytes))
    expect(requests.map(({ range }) => range)).toEqual(['bytes=4-', null, 'bytes=4-'])
    expect(requests.map(({ signal }) => signal)).toEqual([requests[0]!.signal, requests[0]!.signal, requests[0]!.signal])
  })

  it('runs exactly three unique locked artifacts concurrently and queues the fourth', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const artifacts = ['alpha', 'bravo', 'charlie', 'delta'].map((value) => {
      const bytes = Buffer.from(value)
      return { bytes, acquisition: acquisition(bytes, value) }
    })
    const selected = {
      engines: artifacts.map(({ acquisition: coordinate }, index) => ({ name: `engine-${index}`, acquisition: coordinate })),
      formulae: [],
    }
    const pendingResponses = new Map<string, ReturnType<typeof deferred<Response>>>()
    const thirdStarted = deferred<void>()
    const fourthStarted = deferred<void>()
    let active = 0
    let maximumActive = 0
    const starts: string[] = []

    const resultPromise = acquireLockedArtifacts({
      selected,
      cacheRoot,
      fetchImpl: async (input) => {
        const url = String(input)
        starts.push(url)
        active += 1
        maximumActive = Math.max(maximumActive, active)
        const response = deferred<Response>()
        pendingResponses.set(url, response)
        if (starts.length === 3) thirdStarted.resolve()
        if (starts.length === 4) fourthStarted.resolve()
        const value = await response.promise
        active -= 1
        return value
      },
    })

    await thirdStarted.promise
    expect(starts).toHaveLength(3)
    const firstUrl = starts[0]!
    const first = artifacts.find(({ acquisition: value }) => value.url === firstUrl)!
    pendingResponses.get(firstUrl)!.resolve(new Response(first.bytes, { status: 200 }))
    await fourthStarted.promise
    expect(maximumActive).toBe(3)
    for (const url of starts.slice(1)) {
      const artifact = artifacts.find(({ acquisition: value }) => value.url === url)!
      pendingResponses.get(url)!.resolve(new Response(artifact.bytes, { status: 200 }))
    }

    const result = await resultPromise
    expect(starts).toHaveLength(4)
    expect(result.blobs).toBeInstanceOf(Map)
    expect(result.blobs.size).toBe(4)
    expect(result.networkBytes).toBe(22)
  })

  it('deduplicates identical SHA coordinates and rejects conflicting identities before network access', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('shared artifact')
    const coordinate = acquisition(bytes, 'shared')
    const licenseBytes = Buffer.from('license asset')
    const licenseCoordinate = {
      url: 'https://downloads.example.test/license.txt',
      sha256: sha256(licenseBytes),
      bytes: licenseBytes.byteLength,
    }
    let requests = 0
    const selected = {
      engines: [{ name: 'ffmpeg', acquisition: coordinate }],
      formulae: [{
        name: 'ffmpeg',
        acquisition: coordinate,
        licenses: [{
          kind: 'download',
          ...licenseCoordinate,
          destination: 'licenses/ffmpeg.txt',
        }],
      }],
    }
    const result = await acquireLockedArtifacts({
      selected,
      cacheRoot,
      fetchImpl: async (input) => {
        requests += 1
        return new Response(String(input) === coordinate.url ? bytes : licenseBytes, { status: 200 })
      },
    })
    expect(requests).toBe(2)
    expect(result.blobs.size).toBe(2)

    const conflict = structuredClone(selected)
    conflict.engines[0]!.acquisition = {
      ...conflict.engines[0]!.acquisition,
      url: 'https://downloads.example.test/conflict.tar.gz',
    }
    await expect(acquireLockedArtifacts({ selected: conflict, cacheRoot, fetchImpl: async () => {
      requests += 1
      return new Response(bytes, { status: 200 })
    } })).rejects.toThrow('Converter source artifact identities conflict.')
    expect(requests).toBe(2)
  })

  it('aborts active siblings on the first failure, waits for settlement, and never starts queued work', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const artifacts = ['one', 'two', 'three', 'four'].map((value) => {
      const bytes = Buffer.from(value)
      return { bytes, acquisition: acquisition(bytes, value) }
    })
    const selected = {
      engines: artifacts.map(({ acquisition: coordinate }, index) => ({ name: `engine-${index}`, acquisition: coordinate })),
      formulae: [],
    }
    const pendingResponses = new Map<string, ReturnType<typeof deferred<Response>>>()
    const thirdStarted = deferred<void>()
    const starts: string[] = []
    const settled: string[] = []

    const acquisitionPromise = acquireLockedArtifacts({
      selected,
      cacheRoot,
      fetchImpl: async (input, init) => {
        const url = String(input)
        starts.push(url)
        const pending = deferred<Response>()
        pendingResponses.set(url, pending)
        init?.signal?.addEventListener('abort', () => pending.reject(new Error(`aborted ${url}`)), { once: true })
        if (starts.length === 3) thirdStarted.resolve()
        try {
          return await pending.promise
        } finally {
          settled.push(url)
        }
      },
    })

    await thirdStarted.promise
    pendingResponses.get(starts[0]!)!.resolve(new Response('failure', { status: 503 }))
    await expect(acquisitionPromise).rejects.toThrow('Converter source download failed.')
    expect(starts).toHaveLength(3)
    expect(settled).toHaveLength(3)
    expect(readdirSync(cacheRoot).every((name) => /^\.[a-f0-9]{64}\.partial(?:\.json)?$/u.test(name))).toBe(true)
    const names = readdirSync(cacheRoot)
    for (const name of names.filter((value) => value.endsWith('.partial'))) {
      expect(names).toContain(`${name}.json`)
    }
  })

})
