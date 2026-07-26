import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMediaProtocolHandler,
  parseSingleRange,
} from './media-protocol.js'

const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'autoforge-media-protocol-'))
  roots.push(root)
  const directory = join(root, 'conversation_1')
  await mkdir(directory)
  const path = join(directory, 'asset_1.png')
  const bytes = Buffer.from(Array.from({ length: 100 }, (_, index) => index))
  await writeFile(path, bytes)
  const resolveReadyAsset = vi.fn(async (assetId: string) => {
    if (assetId !== 'asset_1') throw new Error('not available')
    return {
      id: assetId,
      conversationId: 'conversation_1',
      kind: 'image' as const,
      mimeType: 'image/png',
      name: 'asset.png',
      byteSize: bytes.byteLength,
      absolutePath: path,
      relativePath: 'conversation_1/asset_1.png',
      inlineSafe: true,
    }
  })
  return { bytes, resolveReadyAsset }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('parseSingleRange', () => {
  it.each([
    ['bytes=10-19', 100, { start: 10, end: 19 }],
    ['bytes=10-', 100, { start: 10, end: 99 }],
    ['bytes=-10', 100, { start: 90, end: 99 }],
  ])('parses %s', (header, size, expected) => {
    expect(parseSingleRange(header, size)).toEqual(expected)
  })

  it.each([
    'bytes=100-101', 'bytes=20-10', 'bytes=-0', 'bytes=0-1,3-4', 'items=0-1', 'bytes=nope',
  ])('rejects malformed or unsatisfiable %s', (header) => {
    expect(parseSingleRange(header, 100)).toBeUndefined()
  })
})

describe('createMediaProtocolHandler', () => {
  it('serves a bounded explicit range with safe response headers', async () => {
    const { bytes, resolveReadyAsset } = await fixture()
    const handler = createMediaProtocolHandler({ resolveReadyAsset })

    const response = await handler(new Request('autoforge-media://asset/asset_1', {
      headers: { range: 'bytes=10-19' },
    }))

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 10-19/100')
    expect(response.headers.get('content-length')).toBe('10')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(10, 20))
    expect(resolveReadyAsset).toHaveBeenCalledWith('asset_1')
  })

  it.each([
    ['bytes=10-', Buffer.from(Array.from({ length: 90 }, (_, index) => index + 10))],
    ['bytes=-10', Buffer.from(Array.from({ length: 10 }, (_, index) => index + 90))],
  ])('serves valid open-ended and suffix ranges', async (range, expected) => {
    const { resolveReadyAsset } = await fixture()
    const response = await createMediaProtocolHandler({ resolveReadyAsset })(new Request(
      'autoforge-media://asset/asset_1', { headers: { range } },
    ))

    expect(response.status).toBe(206)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(expected)
  })

  it('returns a full body for requests without a Range header and no body for HEAD', async () => {
    const { bytes, resolveReadyAsset } = await fixture()
    const handler = createMediaProtocolHandler({ resolveReadyAsset })
    const full = await handler(new Request('autoforge-media://asset/asset_1'))
    const head = await handler(new Request('autoforge-media://asset/asset_1', { method: 'HEAD' }))

    expect(full.status).toBe(200)
    expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes)
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('100')
    expect(head.body).toBeNull()
  })

  it('returns empty 200 GET and HEAD responses without opening a zero-byte asset', async () => {
    const { resolveReadyAsset } = await fixture()
    const asset = await resolveReadyAsset('asset_1')
    const empty = {
      ...asset,
      id: 'empty_asset',
      name: 'empty.png',
      byteSize: 0,
      absolutePath: join(asset.absolutePath, '..', 'empty_asset.png'),
      relativePath: 'conversation_1/empty_asset.png',
    }
    resolveReadyAsset.mockImplementation(async (assetId: string) => {
      if (assetId !== 'empty_asset') throw new Error('not available')
      return empty
    })
    const handler = createMediaProtocolHandler({ resolveReadyAsset })

    const get = await handler(new Request('autoforge-media://asset/empty_asset'))
    const head = await handler(new Request('autoforge-media://asset/empty_asset', { method: 'HEAD' }))

    expect(get.status).toBe(200)
    expect(get.headers.get('content-length')).toBe('0')
    expect((await get.arrayBuffer()).byteLength).toBe(0)
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('0')
    expect(head.body).toBeNull()
  })

  it('returns 416 for every range against a zero-byte asset without opening it', async () => {
    const { resolveReadyAsset } = await fixture()
    const asset = await resolveReadyAsset('asset_1')
    resolveReadyAsset.mockResolvedValueOnce({
      ...asset,
      id: 'empty_asset',
      byteSize: 0,
      absolutePath: join(asset.absolutePath, '..', 'empty_asset.png'),
      relativePath: 'conversation_1/empty_asset.png',
    })

    const response = await createMediaProtocolHandler({ resolveReadyAsset })(new Request(
      'autoforge-media://asset/empty_asset', { headers: { range: 'bytes=0-' } },
    ))

    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */0')
  })

  it.each([
    'autoforge-media://asset/asset_1/extra',
    'autoforge-media://asset/%2e%2e',
    'autoforge-media://asset/asset_1%2fextra',
    'autoforge-media://other/asset_1',
    'autoforge-media://asset/asset_1?query=1',
    'autoforge-media://asset/asset_1#fragment',
  ])('denies non-canonical protocol URLs', async (url) => {
    const { resolveReadyAsset } = await fixture()
    const response = await createMediaProtocolHandler({ resolveReadyAsset })(new Request(url))

    expect(response.status).toBe(404)
    expect(resolveReadyAsset).not.toHaveBeenCalled()
  })

  it.each(['bytes=100-101', 'bytes=0-1,3-4', 'bytes=20-10'])('returns 416 for invalid range %s', async (range) => {
    const { resolveReadyAsset } = await fixture()
    const response = await createMediaProtocolHandler({ resolveReadyAsset })(new Request(
      'autoforge-media://asset/asset_1', { headers: { range } },
    ))

    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */100')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('maps unknown and unavailable assets to safe not-found responses', async () => {
    const { resolveReadyAsset } = await fixture()
    resolveReadyAsset.mockRejectedValueOnce(new Error('database path leaked'))
    const response = await createMediaProtocolHandler({ resolveReadyAsset })(new Request(
      'autoforge-media://asset/missing_asset',
    ))

    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('database path leaked')
  })

  it('rejects a resolver result whose stored relative path does not reconstruct its absolute path', async () => {
    const { resolveReadyAsset } = await fixture()
    const asset = await resolveReadyAsset('asset_1')
    resolveReadyAsset.mockResolvedValueOnce({ ...asset, relativePath: 'conversation_1/other_asset.png' })

    const response = await createMediaProtocolHandler({ resolveReadyAsset })(new Request(
      'autoforge-media://asset/asset_1',
    ))

    expect(response.status).toBe(404)
  })

  it('forces unsafe SVG assets to download', async () => {
    const { resolveReadyAsset } = await fixture()
    const asset = await resolveReadyAsset('asset_1')
    resolveReadyAsset.mockResolvedValueOnce({
      ...asset, mimeType: 'image/svg+xml', name: 'unsafe.svg', inlineSafe: false,
    })
    const response = await createMediaProtocolHandler({ resolveReadyAsset })(new Request(
      'autoforge-media://asset/asset_1', { method: 'HEAD' },
    ))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe('attachment')
  })
})
