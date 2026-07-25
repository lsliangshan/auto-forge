import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import type { MediaAssetService, ResolvedMediaAsset } from './media-asset-service.js'

const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function parseSingleRange(header: string | null, size: number): { start: number; end: number } | undefined {
  if (header === null || !Number.isSafeInteger(size) || size <= 0) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match) return undefined
  const [, startText, endText] = match
  if (!startText && !endText) return undefined

  if (!startText) {
    const suffixLength = Number(endText)
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return undefined
    return { start: Math.max(size - suffixLength, 0), end: size - 1 }
  }

  const start = Number(startText)
  if (!Number.isSafeInteger(start) || start >= size) return undefined
  if (!endText) return { start, end: size - 1 }
  const end = Number(endText)
  if (!Number.isSafeInteger(end) || end < start) return undefined
  return { start, end: Math.min(end, size - 1) }
}

function responseHeaders(asset?: ResolvedMediaAsset): Headers {
  const headers = new Headers({
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  if (!asset) return headers
  headers.set('content-type', asset.mimeType)
  if (asset.mimeType === 'image/svg+xml' || !asset.inlineSafe) headers.set('content-disposition', 'attachment')
  return headers
}

function assetIdFromUrl(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (
    url.protocol !== 'autoforge-media:'
    || url.hostname !== 'asset'
    || url.port !== ''
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || url.hash !== ''
  ) return undefined
  const id = url.pathname.slice(1)
  if (url.pathname !== `/${id}` || !ASSET_ID.test(id)) return undefined
  return id
}

function recheckAssetPath(asset: ResolvedMediaAsset): string | undefined {
  const segments = asset.relativePath.split('/')
  if (
    segments.length !== 2
    || !ASSET_ID.test(segments[0]!)
    || !segments[1]!.startsWith(`${asset.id}.`)
    || segments[1]!.slice(asset.id.length + 1) === ''
  ) return undefined
  const absolutePath = resolve(asset.absolutePath)
  const mediaRoot = resolve(absolutePath, '..', '..')
  return resolve(mediaRoot, ...segments) === absolutePath ? absolutePath : undefined
}

function notFound(): Response {
  return new Response(null, { status: 404, headers: responseHeaders() })
}

function rangeNotSatisfiable(size: number): Response {
  const headers = responseHeaders()
  headers.set('content-range', `bytes */${size}`)
  return new Response(null, { status: 416, headers })
}

export function createMediaProtocolHandler(
  assets: Pick<MediaAssetService, 'resolveReadyAsset'>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const assetId = assetIdFromUrl(request.url)
    if (!assetId) return notFound()

    let asset: ResolvedMediaAsset
    try {
      asset = await assets.resolveReadyAsset(assetId)
    } catch {
      return notFound()
    }
    const assetPath = recheckAssetPath(asset)
    if (!assetPath) return notFound()

    const rangeHeader = request.headers.get('range')
    const range = parseSingleRange(rangeHeader, asset.byteSize)
    if (rangeHeader !== null && !range) return rangeNotSatisfiable(asset.byteSize)
    const start = range?.start ?? 0
    const end = range?.end ?? asset.byteSize - 1
    const headers = responseHeaders(asset)
    headers.set('content-length', String(end - start + 1))
    if (range) headers.set('content-range', `bytes ${start}-${end}/${asset.byteSize}`)

    if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers })
    if (request.method !== 'GET') return new Response(null, { status: 405, headers })
    if (asset.byteSize === 0) return new Response(null, { status: 200, headers })

    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(assetPath, 'r')
      const metadata = await handle.stat()
      if (!metadata.isFile() || metadata.size !== asset.byteSize) {
        await handle.close()
        return notFound()
      }
      const stream = handle.createReadStream({ start, end, autoClose: true })
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
        status: range ? 206 : 200,
        headers,
      })
    } catch {
      await handle?.close().catch(() => undefined)
      return notFound()
    }
  }
}
