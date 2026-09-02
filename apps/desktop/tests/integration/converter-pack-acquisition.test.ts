import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { open as openFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireLockedArtifacts,
  acquireVerifiedArchive,
  hashOpenPartial,
  writeAll,
} from '../../scripts/converter-packs/acquire-sources.mjs'
import { canonicalBytes } from '../../scripts/converter-packs/pack-tooling-lib.mjs'

const temporaryRoots: string[] = []
const spawnedChildren = new Set<ReturnType<typeof spawn>>()
const childCompletionTimeoutMs = 10_000

function waitForChildClose(child: ReturnType<typeof spawn>, timeoutMs = childCompletionTimeoutMs): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => rejectPromise(new Error('Timed out waiting for child process cleanup.')), timeoutMs)
    child.once('close', () => {
      clearTimeout(timeout)
      resolvePromise()
    })
    child.once('error', (error) => {
      clearTimeout(timeout)
      rejectPromise(error)
    })
  })
}

function trackChild(child: ReturnType<typeof spawn>) {
  spawnedChildren.add(child)
  child.once('close', () => spawnedChildren.delete(child))
  child.once('error', () => spawnedChildren.delete(child))
  return child
}

afterEach(async () => {
  const children = [...spawnedChildren]
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  const cleanup = await Promise.allSettled(children.map((child) => waitForChildClose(child)))
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  const failed = cleanup.find((result) => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
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

function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now()
  return new Promise((resolvePromise, rejectPromise) => {
    const check = () => {
      if (predicate()) resolvePromise()
      else if (Date.now() - started >= timeoutMs) rejectPromise(new Error('Timed out waiting for child acquisition state.'))
      else setTimeout(check, 20)
    }
    check()
  })
}

function spawnAcquisitionChild({ cacheRoot, archive, counterPath, mode = 'complete', releasePath = '' }: {
  cacheRoot: string
  archive: { url: string; sha256: string; bytes: number }
  counterPath: string
  mode?: 'complete' | 'crash-owner' | 'wait-release'
  releasePath?: string
}) {
  const moduleUrl = new URL('../../scripts/converter-packs/acquire-sources.mjs', import.meta.url).href
  const script = String.raw`
    import { access, appendFile } from 'node:fs/promises'
    const [moduleUrl, cacheRoot, archiveJson, counterPath, mode, releasePath] = process.argv.slice(1)
    const { acquireVerifiedArchive } = await import(moduleUrl)
    const archive = JSON.parse(archiveJson)
    const bytes = Buffer.from('cross-process artifact')
    const result = await acquireVerifiedArchive({
      archive,
      cacheRoot,
      fetchImpl: async () => {
        await appendFile(counterPath, mode + '\n')
        if (mode === 'crash-owner') await new Promise(() => { setInterval(() => {}, 1_000) })
        if (mode === 'wait-release') {
          while (true) {
            try { await access(releasePath); break } catch { await new Promise((resolve) => setTimeout(resolve, 20)) }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 150))
        return new Response(bytes, { status: 200 })
      },
    })
    process.stdout.write(JSON.stringify(result))
  `
  const child = trackChild(spawn(process.execPath, [
    '--input-type=module', '-e', script, moduleUrl, cacheRoot, JSON.stringify(archive), counterPath, mode, releasePath,
  ], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }))
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (value) => { stdout += value })
  child.stderr.on('data', (value) => { stderr += value })
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => rejectPromise(new Error('Timed out waiting for acquisition child.')), childCompletionTimeoutMs)
    child.once('error', (error) => {
      clearTimeout(timeout)
      rejectPromise(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      if (code !== 0 && signal === null) rejectPromise(new Error(`Acquisition child failed: ${stderr}`))
      else resolvePromise({ code, signal, stdout })
    })
  })
  return { child, completion }
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

function lockedSelection({
  engines,
  formulae = [],
  closureFormulae = formulae.map((formula) => formula.name),
}: {
  engines: Array<Record<string, unknown>>
  formulae?: Array<{ name: string; acquisition?: unknown; licenses?: unknown[] }>
  closureFormulae?: string[]
}) {
  return {
    target: 'darwin-arm64',
    sourceLock: { target: 'darwin-arm64', engines, formulae },
    closureLock: {
      target: 'darwin-arm64',
      formulae: closureFormulae.map((name) => ({ name })),
    },
  }
}

const fixtureOwnerNonce = '00000000-0000-4000-8000-000000000001'

function ownerDataPaths(cacheRoot: string, sha: string, nonce = fixtureOwnerNonce) {
  const partialPath = join(cacheRoot, `.${sha}.${nonce}.partial`)
  return { partialPath, metadataPath: `${partialPath}.json` }
}

function writeOwner(cacheRoot: string, archive: { url: string; sha256: string; bytes: number }, {
  nonce = fixtureOwnerNonce,
  pid = 2_147_483_647,
  state = 'resume',
} = {}) {
  writeFileSync(join(cacheRoot, `.${archive.sha256}.owner`), canonicalBytes({
    bytes: archive.bytes, nonce, pid, sha256: archive.sha256, state, url: archive.url,
  }), { mode: 0o600 })
}

function writePartial(cacheRoot: string, archive: { url: string; sha256: string; bytes: number }, bytes: Buffer, partialBytes = bytes.byteLength) {
  const paths = ownerDataPaths(cacheRoot, archive.sha256)
  writeFileSync(paths.partialPath, bytes, { mode: 0o600 })
  writeFileSync(paths.metadataPath, canonicalBytes({
    bytes: archive.bytes,
    nonce: fixtureOwnerNonce,
    partialBytes,
    sha256: archive.sha256,
    url: archive.url,
  }), { mode: 0o600 })
  writeOwner(cacheRoot, archive)
  return paths
}

describe('converter pack source acquisition', () => {
  it('loops over short writes and advances only by confirmed bytes', async () => {
    const calls: Array<{ offset: number; length: number; position: number }> = []
    const shortWrites = [2, 1, 3]
    const handle = {
      async write(_bytes: Uint8Array, offset: number, length: number, position: number) {
        calls.push({ offset, length, position })
        return { bytesWritten: shortWrites.shift() }
      },
    }

    await expect(writeAll(handle, Buffer.from('abcdef'), 10)).resolves.toBe(6)
    expect(calls).toEqual([
      { offset: 0, length: 6, position: 10 },
      { offset: 2, length: 4, position: 12 },
      { offset: 3, length: 3, position: 13 },
    ])
  })

  it('fails closed when a local write reports no forward progress', async () => {
    const handle = { async write() { return { bytesWritten: 0 } } }
    await expect(writeAll(handle, Buffer.from('x'), 0)).rejects.toThrow('Converter source download failed.')
  })

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
    writePartial(cacheRoot, archive, bytes.subarray(0, 4))
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

  it('batches sub-threshold chunks and safely truncates to the last canonical checkpoint on retry', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.alloc(101, 0x61)
    const archive = {
      url: 'https://downloads.example.test/checkpoint-batch.tar.gz',
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    }
    const reached = deferred<void>()
    const blocked = deferred<void>()
    let emitted = 0
    let cancelled = false
    const controller = new AbortController()
    const first = acquireVerifiedArchive({
      archive,
      cacheRoot,
      signal: controller.signal,
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        pull(stream) {
          if (emitted < 100) {
            stream.enqueue(Uint8Array.of(0x61))
            emitted += 1
            if (emitted === 100) reached.resolve()
            return
          }
          return blocked.promise
        },
        cancel() {
          cancelled = true
          blocked.resolve()
        },
      }), { status: 200 }),
    })
    await reached.promise
    const activeOwner = JSON.parse(readFileSync(join(cacheRoot, `.${archive.sha256}.owner`), 'utf8'))
    const { partialPath, metadataPath } = ownerDataPaths(cacheRoot, archive.sha256, activeOwner.nonce)
    await waitUntil(() => lstatSync(partialPath).size === 100)
    expect(JSON.parse(readFileSync(metadataPath, 'utf8')).partialBytes).toBe(0)
    controller.abort()
    await expect(first).rejects.toThrow('Converter source download failed.')
    expect(cancelled).toBe(true)
    expect(lstatSync(partialPath).size).toBe(100)

    let range: string | null = 'not-requested'
    const recovered = await acquireVerifiedArchive({
      archive,
      cacheRoot,
      fetchImpl: async (_input, init) => {
        range = new Headers(init?.headers).get('range')
        return new Response(bytes, { status: 200 })
      },
    })
    expect(range).toBe(null)
    expect(readFileSync(recovered.path)).toEqual(bytes)
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
    const paths = writePartial(cacheRoot, archive, bytes.subarray(0, 4))
    const metadata = { ...archive, nonce: fixtureOwnerNonce, partialBytes: 4 }
    mutate(metadata)
    writeFileSync(paths.metadataPath, canonicalBytes(metadata), { mode: 0o600 })
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
    const { partialPath, metadataPath } = ownerDataPaths(cacheRoot, archive.sha256)
    symlinkSync(external, partialPath)
    writeFileSync(metadataPath, canonicalBytes({
      bytes: archive.bytes, nonce: fixtureOwnerNonce, partialBytes: 4, sha256: archive.sha256, url: archive.url,
    }), { mode: 0o600 })
    writeOwner(cacheRoot, archive)

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

  it('recovers a verified link-after-publication crash without another request', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('already linked archive')
    const archive = {
      url: 'https://downloads.example.test/linked-crash.tar.gz',
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    }
    const { partialPath } = writePartial(cacheRoot, archive, bytes)
    const target = join(cacheRoot, `${archive.sha256}.archive`)
    linkSync(partialPath, target)
    expect(lstatSync(partialPath).nlink).toBe(2)
    let requests = 0

    const result = await acquireVerifiedArchive({
      archive,
      cacheRoot,
      fetchImpl: async () => {
        requests += 1
        return new Response(bytes, { status: 200 })
      },
    })

    expect(requests).toBe(0)
    expect(result.networkBytes).toBe(0)
    expect(lstatSync(result.path).nlink).toBe(1)
    expect(readdirSync(cacheRoot)).toEqual([`${archive.sha256}.archive`])
  })

  it('detects replacement of the canonical partial path while retaining the replacement', async () => {
    const root = temporaryRoot()
    const bytes = Buffer.from('verified open handle')
    const archive = {
      url: 'https://downloads.example.test/path-replacement.tar.gz',
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    }
    const partialPath = join(root, 'partial')
    writeFileSync(partialPath, bytes, { mode: 0o600 })
    const handle = await openFile(partialPath, 'r')
    try {
      rmSync(partialPath)
      writeFileSync(partialPath, bytes, { mode: 0o600 })
      await expect(hashOpenPartial(handle, partialPath, archive, 1))
        .rejects.toThrow('Converter source download failed.')
      expect(readFileSync(partialPath)).toEqual(bytes)
      expect(lstatSync(partialPath).ino).not.toBe((await handle.stat()).ino)
    } finally {
      await handle.close()
    }
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

  it.each([
    ['dead active', 'active'],
    ['parked resume', 'resume'],
  ])('cleans a %s owner beside an already valid target without another request', async (_label, state) => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('valid target with stale owner')
    const archive = {
      url: 'https://downloads.example.test/valid-target-owner.tar.gz',
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    }
    writeFileSync(join(cacheRoot, `${archive.sha256}.archive`), bytes, { mode: 0o600 })
    writeOwner(cacheRoot, archive, { state })
    let requests = 0

    const result = await acquireVerifiedArchive({
      archive,
      cacheRoot,
      fetchImpl: async () => {
        requests += 1
        return new Response(bytes, { status: 200 })
      },
    })

    expect(result.networkBytes).toBe(0)
    expect(requests).toBe(0)
    expect(readdirSync(cacheRoot)).toEqual([`${archive.sha256}.archive`])
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
    const archiveUrl = `https://ghcr.io/v2/homebrew/core/openssl/3/blobs/sha256:${sha256(bytes)}`
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
            'www-authenticate': 'bEaReR\t scope="repository:homebrew/core/openssl/3:pull" , realm = "https://ghcr.io/token", service="ghcr.io"',
          },
        })
      }
      if (url === 'https://ghcr.io/token?service=ghcr.io&scope=repository%3Ahomebrew%2Fcore%2Fopenssl%2F3%3Apull') {
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

  it('rejects a GHCR bearer scope that does not match the locked blob repository', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('versioned bottle bytes')
    const archive = {
      url: `https://ghcr.io/v2/homebrew/core/openssl/3/blobs/sha256:${sha256(bytes)}`,
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    }
    let requests = 0

    await expect(acquireVerifiedArchive({
      archive,
      cacheRoot,
      fetchImpl: async () => {
        requests += 1
        return new Response('unauthorized', {
          status: 401,
          headers: {
            'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:homebrew/core/openssl:pull"',
          },
        })
      },
    })).rejects.toThrow('Converter source authentication failed.')
    expect(requests).toBe(1)
  })

  it.each([
    ['duplicate', 'Bearer realm="https://ghcr.io/token",realm="https://ghcr.io/token",service="ghcr.io",scope="repository:homebrew/core/openssl/3:pull"'],
    ['unknown', 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:homebrew/core/openssl/3:pull",nonce="x"'],
    ['unquoted', 'Bearer realm=https://ghcr.io/token,service="ghcr.io",scope="repository:homebrew/core/openssl/3:pull"'],
    ['escaped', 'Bearer realm="https://ghcr.io\\/token",service="ghcr.io",scope="repository:homebrew/core/openssl/3:pull"'],
    ['malformed trailing comma', 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:homebrew/core/openssl/3:pull",'],
  ])('rejects a %s GHCR bearer challenge', async (_label, challenge) => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('malformed challenge')
    const archive = {
      url: `https://ghcr.io/v2/homebrew/core/openssl/3/blobs/sha256:${sha256(bytes)}`,
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    }
    let requests = 0

    await expect(acquireVerifiedArchive({
      archive,
      cacheRoot,
      fetchImpl: async () => {
        requests += 1
        return new Response('unauthorized', { status: 401, headers: { 'www-authenticate': challenge } })
      },
    })).rejects.toThrow('Converter source authentication failed.')
    expect(requests).toBe(1)
  })

  it('cancels the challenge body before rejecting an unsafe locked GHCR repository path', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('unsafe repository bottle')
    const archive = {
      url: `https://ghcr.io/v2/another/project/blobs/sha256:${sha256(bytes)}`,
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    }
    let cancelled = false

    await expect(acquireVerifiedArchive({
      archive,
      cacheRoot,
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        pull() {},
        cancel() { cancelled = true },
      }), {
        status: 401,
        headers: {
          'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:another/project:pull"',
        },
      }),
    })).rejects.toThrow('Converter source authentication failed.')
    expect(cancelled).toBe(true)
  })

  it('cancels an unconsumed GHCR token error body', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('token failure bottle')
    const archive = {
      url: `https://ghcr.io/v2/homebrew/core/openssl/3/blobs/sha256:${sha256(bytes)}`,
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    }
    let cancelled = false

    await expect(acquireVerifiedArchive({
      archive,
      cacheRoot,
      fetchImpl: async (input) => {
        if (String(input).startsWith('https://ghcr.io/token?')) {
          return new Response(new ReadableStream<Uint8Array>({
            pull() {},
            cancel() { cancelled = true },
          }), { status: 503 })
        }
        return new Response('unauthorized', {
          status: 401,
          headers: {
            'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:homebrew/core/openssl/3:pull"',
          },
        })
      },
    })).rejects.toThrow('Converter source authentication failed.')
    expect(cancelled).toBe(true)
  })

  it('cancels the archive reader when a local metadata checkpoint fails', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.alloc(16 * 1024 * 1024, 0x61)
    const archive = {
      url: 'https://downloads.example.test/metadata-failure.tar.gz',
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    }
    let pulled = false
    let cancelled = false

    await expect(acquireVerifiedArchive({
      archive,
      cacheRoot,
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled) return
          pulled = true
          const owner = JSON.parse(readFileSync(join(cacheRoot, `.${archive.sha256}.owner`), 'utf8'))
          const { metadataPath } = ownerDataPaths(cacheRoot, archive.sha256, owner.nonce)
          rmSync(metadataPath)
          mkdirSync(metadataPath)
          controller.enqueue(bytes)
        },
        cancel() { cancelled = true },
      }), { status: 200 }),
    })).rejects.toThrow('Converter source download failed.')
    expect(cancelled).toBe(true)
  })

  it('cancels the archive reader after an empty response chunk', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('nonempty archive')
    let cancelled = false

    await expect(acquireVerifiedArchive({
      archive: {
        url: 'https://downloads.example.test/empty-chunk.tar.gz',
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
      },
      cacheRoot,
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array()) },
        cancel() { cancelled = true },
      }), { status: 200 }),
    })).rejects.toThrow('Converter source download failed.')
    expect(cancelled).toBe(true)
  })

  it('runs exactly three unique locked artifacts concurrently and queues the fourth', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const artifacts = ['alpha', 'bravo', 'charlie', 'delta'].map((value) => {
      const bytes = Buffer.from(value)
      return { bytes, acquisition: acquisition(bytes, value) }
    })
    const selected = lockedSelection({
      engines: artifacts.map(({ acquisition: coordinate }, index) => ({ name: `engine-${index}`, acquisition: coordinate })),
    })
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

  it('shares one in-process SHA owner while a later caller aborts independently', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('shared in-process download')
    const archive = {
      url: 'https://downloads.example.test/shared-owner.tar.gz',
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    }
    const response = deferred<Response>()
    const started = deferred<void>()
    let requests = 0
    const fetchImpl: typeof fetch = async () => {
      requests += 1
      started.resolve()
      return response.promise
    }

    const owner = acquireVerifiedArchive({ archive, cacheRoot, fetchImpl })
    await started.promise
    const follower = acquireVerifiedArchive({ archive, cacheRoot, fetchImpl })
    const controller = new AbortController()
    const waiter = acquireVerifiedArchive({ archive, cacheRoot, fetchImpl, signal: controller.signal })
    controller.abort()
    await expect(waiter).rejects.toThrow('Converter source download failed.')
    const active = JSON.parse(readFileSync(join(cacheRoot, `.${archive.sha256}.owner`), 'utf8'))
    const activePaths = ownerDataPaths(cacheRoot, archive.sha256, active.nonce)
    expect(readdirSync(cacheRoot).sort()).toEqual([
      `.${archive.sha256}.${active.nonce}.partial`,
      `.${archive.sha256}.${active.nonce}.partial.json`,
      `.${archive.sha256}.owner`,
    ])
    expect(lstatSync(activePaths.partialPath).isFile()).toBe(true)
    response.resolve(new Response(bytes, { status: 200 }))

    const [result, followerResult] = await Promise.all([owner, follower])
    expect(followerResult).toEqual(result)
    expect(readFileSync(result.path)).toEqual(bytes)
    expect(requests).toBe(1)
    expect(readdirSync(cacheRoot)).toEqual([`${archive.sha256}.archive`])
  })

  it('shares one fresh owner across independently imported module instances in the same process', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('query imported owner')
    const archive = {
      url: 'https://downloads.example.test/query-import-owner.tar.gz',
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    }
    const moduleUrl = new URL('../../scripts/converter-packs/acquire-sources.mjs', import.meta.url).href
    const [firstModule, secondModule] = await Promise.all([
      import(`${moduleUrl}?owner-instance=first`),
      import(`${moduleUrl}?owner-instance=second`),
    ])
    const release = deferred<void>()
    let requests = 0
    const fetchImpl: typeof fetch = async () => {
      requests += 1
      await release.promise
      return new Response(bytes, { status: 200 })
    }

    const first = firstModule.acquireVerifiedArchive({ archive, cacheRoot, fetchImpl })
    await waitUntil(() => requests === 1)
    const second = secondModule.acquireVerifiedArchive({ archive, cacheRoot, fetchImpl })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    release.resolve()

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(secondResult).toEqual(firstResult)
    expect(requests).toBe(1)
    expect(readdirSync(cacheRoot)).toEqual([`${archive.sha256}.archive`])
  })

  it('reclaims an expired owner lease even when its PID belongs to a live unrelated process', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('lease recovered artifact')
    const archive = {
      url: 'https://downloads.example.test/expired-live-owner.tar.gz',
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    }
    writePartial(cacheRoot, archive, bytes.subarray(0, 5))
    const unrelated = trackChild(spawn(process.execPath, ['--input-type=module', '-e', 'setInterval(() => {}, 1_000)'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'ignore',
    }))
    await new Promise<void>((resolvePromise, rejectPromise) => {
      unrelated.once('spawn', resolvePromise)
      unrelated.once('error', rejectPromise)
    })
    const ownerPath = join(cacheRoot, `.${archive.sha256}.owner`)
    writeFileSync(ownerPath, canonicalBytes({
      bytes: archive.bytes,
      nonce: fixtureOwnerNonce,
      pid: unrelated.pid,
      sha256: archive.sha256,
      state: 'active',
      url: archive.url,
    }), { mode: 0o600 })
    const expired = new Date(Date.now() - 2 * 60 * 1_000)
    utimesSync(ownerPath, expired, expired)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 750)
    let range: string | null = 'not-requested'
    try {
      const result = await acquireVerifiedArchive({
        archive,
        cacheRoot,
        signal: controller.signal,
        fetchImpl: async (_input, init) => {
          range = new Headers(init?.headers).get('range')
          return new Response(bytes, { status: 200 })
        },
      })
      expect(readFileSync(result.path)).toEqual(bytes)
    } finally {
      clearTimeout(timeout)
    }
    expect(range).toBe(null)
    expect(readdirSync(cacheRoot)).toEqual([`${archive.sha256}.archive`])
  })

  it('does not let a resumed stale owner modify or remove its successor data', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const counterPath = join(root, 'requests.log')
    const successorReleasePath = join(root, 'release-successor')
    writeFileSync(counterPath, '')
    const bytes = Buffer.from('cross-process artifact')
    const archive = {
      url: 'https://downloads.example.test/stale-owner-fencing.tar.gz',
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    }
    const started = deferred<void>()
    const release = deferred<void>()
    const stale = acquireVerifiedArchive({
      archive,
      cacheRoot,
      fetchImpl: async () => {
        started.resolve()
        await release.promise
        return new Response(bytes, { status: 200 })
      },
    })
    await started.promise
    const ownerPath = join(cacheRoot, `.${archive.sha256}.owner`)
    const expired = new Date(Date.now() - 2 * 60 * 1_000)
    utimesSync(ownerPath, expired, expired)

    const successor = spawnAcquisitionChild({
      cacheRoot, archive, counterPath, mode: 'wait-release', releasePath: successorReleasePath,
    })
    await waitUntil(() => readFileSync(counterPath, 'utf8').includes('wait-release'))
    const successorOwnerBefore = readFileSync(ownerPath, 'utf8')
    const successorOwner = JSON.parse(successorOwnerBefore)
    const successorPaths = ownerDataPaths(cacheRoot, archive.sha256, successorOwner.nonce)
    const successorPartialBefore = readFileSync(successorPaths.partialPath)
    const successorMetadataBefore = readFileSync(successorPaths.metadataPath)
    release.resolve()
    await expect(stale).rejects.toThrow('Converter source download failed.')
    expect(readFileSync(ownerPath, 'utf8')).toBe(successorOwnerBefore)
    expect(readFileSync(successorPaths.partialPath)).toEqual(successorPartialBefore)
    expect(readFileSync(successorPaths.metadataPath)).toEqual(successorMetadataBefore)

    writeFileSync(successorReleasePath, '')
    const successorResult = await successor.completion
    expect(JSON.parse(successorResult.stdout).sha256).toBe(archive.sha256)
    expect(readFileSync(join(cacheRoot, `${archive.sha256}.archive`))).toEqual(bytes)
    expect(readdirSync(cacheRoot)).toEqual([`${archive.sha256}.archive`])
  })

  it('keeps the winner nonce data isolated when two contenders reclaim one stale owner', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const counterPath = join(root, 'requests.log')
    writeFileSync(counterPath, '')
    const bytes = Buffer.from('cross-process artifact')
    const archive = {
      url: 'https://downloads.example.test/stale-contenders.tar.gz',
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    }
    writePartial(cacheRoot, archive, bytes.subarray(0, 5))
    const unrelated = trackChild(spawn(process.execPath, ['--input-type=module', '-e', 'setInterval(() => {}, 1_000)'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'ignore',
    }))
    await new Promise<void>((resolvePromise, rejectPromise) => {
      unrelated.once('spawn', resolvePromise)
      unrelated.once('error', rejectPromise)
    })
    const ownerPath = join(cacheRoot, `.${archive.sha256}.owner`)
    writeOwner(cacheRoot, archive, { nonce: fixtureOwnerNonce, pid: unrelated.pid, state: 'active' })
    const expired = new Date(Date.now() - 2 * 60 * 1_000)
    utimesSync(ownerPath, expired, expired)

    const first = spawnAcquisitionChild({ cacheRoot, archive, counterPath })
    const second = spawnAcquisitionChild({ cacheRoot, archive, counterPath })
    const results = await Promise.all([first.completion, second.completion])

    expect(results.map(({ stdout }) => JSON.parse(stdout).sha256)).toEqual([archive.sha256, archive.sha256])
    expect(readFileSync(counterPath, 'utf8').trim().split('\n')).toEqual(['complete'])
    expect(readFileSync(join(cacheRoot, `${archive.sha256}.archive`))).toEqual(bytes)
    expect(readdirSync(cacheRoot)).toEqual([`${archive.sha256}.archive`])
  })

  it('serializes concurrent child processes behind one SHA owner and one network request', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const counterPath = join(root, 'requests.log')
    writeFileSync(counterPath, '')
    const bytes = Buffer.from('cross-process artifact')
    const archive = {
      url: 'https://downloads.example.test/cross-process.tar.gz',
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    }

    const first = spawnAcquisitionChild({ cacheRoot, archive, counterPath })
    const second = spawnAcquisitionChild({ cacheRoot, archive, counterPath })
    const [firstResult, secondResult] = await Promise.all([first.completion, second.completion])

    const results = [JSON.parse(firstResult.stdout), JSON.parse(secondResult.stdout)]
    expect(results.map(({ path, sha256: digest, bytes: size }) => ({ path, sha256: digest, bytes: size })))
      .toEqual([0, 1].map(() => ({ path: join(cacheRoot, `${archive.sha256}.archive`), sha256: archive.sha256, bytes: archive.bytes })))
    expect(results.map(({ networkBytes }) => networkBytes).sort((left, right) => left - right)).toEqual([0, archive.bytes])
    expect(readFileSync(counterPath, 'utf8').trim().split('\n')).toEqual(['complete'])
    expect(readdirSync(cacheRoot)).toEqual([`${archive.sha256}.archive`])
  })

  it('reclaims a crashed child owner and resumes its canonical partial', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const counterPath = join(root, 'requests.log')
    writeFileSync(counterPath, '')
    const bytes = Buffer.from('cross-process artifact')
    const archive = {
      url: 'https://downloads.example.test/crash-recovery.tar.gz',
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    }
    const crashed = spawnAcquisitionChild({ cacheRoot, archive, counterPath, mode: 'crash-owner' })
    await waitUntil(() => readFileSync(counterPath, 'utf8').includes('crash-owner'))
    crashed.child.kill('SIGKILL')
    const crashResult = await crashed.completion
    expect(crashResult.signal).toBe('SIGKILL')

    const recovered = spawnAcquisitionChild({ cacheRoot, archive, counterPath })
    const recoveredResult = await recovered.completion
    expect(JSON.parse(recoveredResult.stdout).sha256).toBe(archive.sha256)
    expect(readFileSync(counterPath, 'utf8').trim().split('\n')).toEqual(['crash-owner', 'complete'])
    expect(readdirSync(cacheRoot)).toEqual([`${archive.sha256}.archive`])
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
    const selected = lockedSelection({
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
    })
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
    conflict.sourceLock.engines[0]!.acquisition = {
      ...conflict.sourceLock.engines[0]!.acquisition,
      url: 'https://downloads.example.test/conflict.tar.gz',
    }
    await expect(acquireLockedArtifacts({ selected: conflict, cacheRoot, fetchImpl: async () => {
      requests += 1
      return new Response(bytes, { status: 200 })
    } })).rejects.toThrow('Converter source artifact identities conflict.')
    expect(requests).toBe(2)
  })

  it('acquires formula bottles and direct licenses only from the authenticated target closure', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const engineBytes = Buffer.from('engine')
    const selectedBytes = Buffer.from('selected formula')
    const selectedLicenseBytes = Buffer.from('selected license')
    const unusedBytes = Buffer.from('unused formula')
    const unusedLicenseBytes = Buffer.from('unused license')
    const engine = acquisition(engineBytes, 'engine')
    const selectedFormula = acquisition(selectedBytes, 'selected')
    const unusedFormula = acquisition(unusedBytes, 'unused')
    const selectedLicense = {
      kind: 'download',
      url: 'https://downloads.example.test/selected-license.txt',
      sha256: sha256(selectedLicenseBytes),
      bytes: selectedLicenseBytes.byteLength,
      destination: 'licenses/selected.txt',
    }
    const unusedLicense = {
      kind: 'download',
      url: 'https://downloads.example.test/unused-license.txt',
      sha256: sha256(unusedLicenseBytes),
      bytes: unusedLicenseBytes.byteLength,
      destination: 'licenses/unused.txt',
    }
    const selected = lockedSelection({
      engines: [{ name: 'engine', acquisition: engine }],
      formulae: [
        { name: 'selected', acquisition: selectedFormula, licenses: [selectedLicense] },
        { name: 'unused', acquisition: unusedFormula, licenses: [unusedLicense] },
      ],
      closureFormulae: ['selected'],
    })
    const bodies = new Map([
      [engine.url, engineBytes],
      [selectedFormula.url, selectedBytes],
      [selectedLicense.url, selectedLicenseBytes],
      [unusedFormula.url, unusedBytes],
      [unusedLicense.url, unusedLicenseBytes],
    ])
    const requests: string[] = []

    const result = await acquireLockedArtifacts({
      selected,
      cacheRoot,
      fetchImpl: async (input) => {
        const url = String(input)
        requests.push(url)
        return new Response(bodies.get(url), { status: 200 })
      },
    })

    expect(requests.sort()).toEqual([engine.url, selectedFormula.url, selectedLicense.url].sort())
    expect(result.networkBytes).toBe(engineBytes.byteLength + selectedBytes.byteLength + selectedLicenseBytes.byteLength)
    expect(result.blobs.has(unusedFormula.sha256)).toBe(false)
    expect(result.blobs.has(unusedLicense.sha256)).toBe(false)
  })

  it('rejects an unknown target-closure formula before making requests', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('engine')
    const selected = lockedSelection({
      engines: [{ name: 'engine', acquisition: acquisition(bytes, 'engine') }],
      formulae: [],
      closureFormulae: ['missing'],
    })
    let requests = 0

    await expect(acquireLockedArtifacts({
      selected,
      cacheRoot,
      fetchImpl: async () => {
        requests += 1
        return new Response(bytes, { status: 200 })
      },
    })).rejects.toThrow('Converter source closure references an unknown formula.')
    expect(requests).toBe(0)
  })

  it('aborts active siblings on the first failure, waits for settlement, and never starts queued work', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const artifacts = ['one', 'two', 'three', 'four'].map((value) => {
      const bytes = Buffer.from(value)
      return { bytes, acquisition: acquisition(bytes, value) }
    })
    const selected = lockedSelection({
      engines: artifacts.map(({ acquisition: coordinate }, index) => ({ name: `engine-${index}`, acquisition: coordinate })),
    })
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
    const names = readdirSync(cacheRoot)
    expect(names.every((name) => (
      /^\.[a-f0-9]{64}\.owner$/u.test(name)
      || /^\.[a-f0-9]{64}\.[a-f0-9-]{36}\.partial(?:\.json)?$/u.test(name)
    ))).toBe(true)
    for (const name of names.filter((value) => value.endsWith('.partial'))) {
      expect(names).toContain(`${name}.json`)
    }
  })

})
