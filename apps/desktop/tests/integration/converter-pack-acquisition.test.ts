import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireSelectedConverterSources,
  acquireVerifiedArchive,
} from '../../scripts/converter-packs/acquire-sources.mjs'

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

describe('converter pack source acquisition', () => {
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
    }

    const first = await acquireVerifiedArchive({ archive, cacheRoot, fetchImpl })
    const second = await acquireVerifiedArchive({ archive, cacheRoot, fetchImpl })

    expect(first).toEqual({
      path: join(cacheRoot, `${archive.sha256}.archive`),
      sha256: archive.sha256,
      bytes: 32,
    })
    expect(second).toEqual(first)
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
      archive: { url: 'https://downloads.example.test/engine.tar.xz', sha256: digest },
      cacheRoot,
      fetchImpl: async () => {
        requests += 1
        return new Response(expected, { status: 200 })
      },
    })).rejects.toThrow('Cached converter archive hash does not match the source lock.')
    expect(readFileSync(cachePath, 'utf8')).toBe('corrupted cache entry')
    expect(requests).toBe(0)
  })

  it('rejects hash-mismatched bytes without occupying the immutable cache key', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const expected = Buffer.from('expected archive')
    const received = Buffer.from('hostile replacement')

    await expect(acquireVerifiedArchive({
      archive: {
        url: 'https://downloads.example.test/engine.tar.xz',
        sha256: sha256(expected),
      },
      cacheRoot,
      fetchImpl: async () => new Response(received, { status: 200 }),
    })).rejects.toThrow('Downloaded converter archive hash does not match the source lock.')
    expect(readdirSync(cacheRoot)).toEqual([])
  })

  it('rejects an archive whose declared length exceeds the caller byte cap', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('12345')

    await expect(acquireVerifiedArchive({
      archive: {
        url: 'https://downloads.example.test/engine.tar.xz',
        sha256: sha256(bytes),
      },
      cacheRoot,
      maximumBytes: 4,
      fetchImpl: async () => new Response(bytes, {
        status: 200,
        headers: { 'content-length': '5' },
      }),
    })).rejects.toThrow('Converter source download exceeds its size limit.')
    expect(readdirSync(cacheRoot)).toEqual([])
  })

  it('enforces the byte cap while streaming when content-length is absent', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const bytes = Buffer.from('12345')

    await expect(acquireVerifiedArchive({
      archive: {
        url: 'https://downloads.example.test/engine.tar.xz',
        sha256: sha256(bytes),
      },
      cacheRoot,
      maximumBytes: 4,
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      }), { status: 200 }),
    })).rejects.toThrow('Converter source download exceeds its size limit.')
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
      },
      cacheRoot,
      fetchImpl: async () => new Response(bytes, { status: 503 }),
    })).rejects.toThrow('Converter source download failed.')
    expect(readdirSync(cacheRoot)).toEqual([])
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
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      const authorization = new Headers(init?.headers).get('authorization')
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
      if (url === archiveUrl && authorization === 'Bearer fixture-token') return new Response(bytes, { status: 200 })
      return new Response('unexpected request', { status: 500 })
    }

    const result = await acquireVerifiedArchive({
      archive: { url: archiveUrl, sha256: sha256(bytes) },
      cacheRoot,
      fetchImpl,
    })

    expect(readFileSync(result.path)).toEqual(bytes)
    expect(result.sha256).toBe(sha256(bytes))
  })

  it('acquires both source and runtime archives for every selected engine', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const sourceBytes = Buffer.from('source')
    const runtimeBytes = Buffer.from('runtime')
    const selected = {
      target: 'darwin-arm64',
      homebrewCoreRevision: '1'.repeat(40),
      homebrewCaskRevision: '2'.repeat(40),
      engines: [{
        name: 'ffmpeg',
        version: '9.0.1+1',
        license: 'GPL-3.0-or-later',
        source: {
          url: 'https://downloads.example.test/ffmpeg-source.tar.xz',
          sha256: sha256(sourceBytes),
        },
        acquisition: {
          kind: 'homebrew-bottle',
          url: 'https://downloads.example.test/ffmpeg-bottle.tar.gz',
          sha256: sha256(runtimeBytes),
          cellar: '/opt/homebrew/Cellar',
        },
      }],
    }
    const bodies = new Map([
      [selected.engines[0]!.source.url, sourceBytes],
      [selected.engines[0]!.acquisition.url, runtimeBytes],
    ])

    const acquired = await acquireSelectedConverterSources({
      selected,
      cacheRoot,
      fetchImpl: async (input) => {
        const bytes = bodies.get(String(input))
        return bytes === undefined ? new Response('missing fixture', { status: 404 }) : new Response(bytes, { status: 200 })
      },
    })

    expect(acquired).toEqual({
      target: 'darwin-arm64',
      homebrewCoreRevision: '1111111111111111111111111111111111111111',
      homebrewCaskRevision: '2222222222222222222222222222222222222222',
      engines: [{
        name: 'ffmpeg',
        version: '9.0.1+1',
        license: 'GPL-3.0-or-later',
        sourceArchive: {
          path: join(cacheRoot, `${sha256(sourceBytes)}.archive`),
          sha256: sha256(sourceBytes),
          bytes: 6,
        },
        acquisition: {
          kind: 'homebrew-bottle',
          cellar: '/opt/homebrew/Cellar',
          archive: {
            path: join(cacheRoot, `${sha256(runtimeBytes)}.archive`),
            sha256: sha256(runtimeBytes),
            bytes: 7,
          },
        },
      }],
    })
    expect(readFileSync(acquired.engines[0]!.sourceArchive.path)).toEqual(sourceBytes)
    expect(readFileSync(acquired.engines[0]!.acquisition.archive.path)).toEqual(runtimeBytes)
  })
})
