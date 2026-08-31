import { createHash, randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { link, lstat, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { pathToFileURL, URL } from 'node:url'
import {
  fail,
  parseArguments,
  readStableRegularFile,
  requireAbsolutePath,
  requireDirectory,
} from './pack-tooling-lib.mjs'
import { loadConverterSourceLock } from './source-lock.mjs'

const sha256Pattern = /^[a-f0-9]{64}$/u

function validHttpsUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048 || value !== value.trim()) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password && !url.hash
  } catch {
    return false
  }
}

function validArchiveIdentity(value) {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === ['sha256', 'url'].join('\0')
    && validHttpsUrl(value.url)
    && sha256Pattern.test(value.sha256)
}

async function boundedToken(response) {
  if (!response.ok || response.status !== 200 || !response.body || (response.url && !validHttpsUrl(response.url))) {
    fail('Converter source authentication failed.')
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > 16 * 1024) {
        await reader.cancel().catch(() => undefined)
        fail('Converter source authentication failed.')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  let value
  try {
    value = JSON.parse(Buffer.concat(chunks, total).toString('utf8'))
  } catch {
    fail('Converter source authentication failed.')
  }
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || Object.keys(value).join('\0') !== 'token'
    || typeof value.token !== 'string'
    || value.token.length < 1
    || value.token.length > 8_192
  ) fail('Converter source authentication failed.')
  return value.token
}

async function fetchArchive(fetchImpl, archiveUrl, init) {
  let response = await fetchImpl(archiveUrl, init)
  const archive = new URL(archiveUrl)
  if (response.status !== 401 || archive.hostname !== 'ghcr.io') return response
  const challenge = response.headers.get('www-authenticate')
  const match = /^Bearer realm="(https:\/\/ghcr\.io\/token)",service="(ghcr\.io)",scope="(repository:homebrew\/core\/[A-Za-z0-9._-]+:pull)"$/u.exec(challenge ?? '')
  if (!match) fail('Converter source authentication failed.')
  const tokenUrl = new URL(match[1])
  tokenUrl.searchParams.set('service', match[2])
  tokenUrl.searchParams.set('scope', match[3])
  const token = await boundedToken(await fetchImpl(tokenUrl.href, init))
  response = await fetchImpl(archiveUrl, {
    ...init,
    headers: { authorization: `Bearer ${token}` },
  })
  return response
}

async function cachedArchive(path, expectedSha256) {
  const metadata = await lstat(path).catch((error) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  })
  if (metadata === undefined) return undefined
  const bytes = await readStableRegularFile(path, 'Cached converter archive')
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
    fail('Cached converter archive hash does not match the source lock.')
  }
  return { path, sha256: expectedSha256, bytes: bytes.byteLength }
}

export async function acquireVerifiedArchive({ archive, cacheRoot, maximumBytes = 1024 * 1024 * 1024, fetchImpl = globalThis.fetch }) {
  if (!validArchiveIdentity(archive)) fail('Converter source archive identity is invalid.')
  requireAbsolutePath(cacheRoot, 'Converter source cache root')
  await requireDirectory(cacheRoot, 'Converter source cache root')
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 1024 * 1024 * 1024) {
    fail('Converter source download size limit is invalid.')
  }
  const target = join(cacheRoot, `${archive.sha256}.archive`)
  const cached = await cachedArchive(target, archive.sha256)
  if (cached !== undefined) return cached

  const temporary = join(cacheRoot, `.${archive.sha256}.${randomUUID()}.downloading`)
  const handle = await open(temporary, 'wx', 0o600)
  let total = 0
  const digest = createHash('sha256')
  try {
    const requestInit = {
      method: 'GET',
      redirect: 'follow',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    }
    const response = await fetchArchive(fetchImpl, archive.url, requestInit)
    if (
      !response.ok
      || response.status !== 200
      || !response.body
      || (response.url.length > 0 && !validHttpsUrl(response.url))
    ) fail('Converter source download failed.')
    const declared = response.headers.get('content-length')
    if (declared !== null && (!/^(?:0|[1-9]\d*)$/u.test(declared) || Number(declared) > maximumBytes)) {
      fail('Converter source download exceeds its size limit.')
    }
    const reader = response.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (!Number.isSafeInteger(total) || total > maximumBytes) {
          await reader.cancel().catch(() => undefined)
          fail('Converter source download exceeds its size limit.')
        }
        digest.update(value)
        await handle.write(value)
      }
    } finally {
      reader.releaseLock()
    }
    if (total === 0 || digest.digest('hex') !== archive.sha256) {
      fail('Downloaded converter archive hash does not match the source lock.')
    }
    await handle.sync()
    await handle.close()
    await link(temporary, target).catch(async (error) => {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
      await cachedArchive(target, archive.sha256)
    })
    await unlink(temporary)
    return { path: target, sha256: archive.sha256, bytes: total }
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

export async function acquireSelectedConverterSources({
  selected,
  cacheRoot,
  maximumBytes = 1024 * 1024 * 1024,
  fetchImpl = globalThis.fetch,
}) {
  const engines = await Promise.all(selected.engines.map(async (engine) => {
    const [sourceArchive, runtimeArchive] = await Promise.all([
      acquireVerifiedArchive({ archive: engine.source, cacheRoot, maximumBytes, fetchImpl }),
      acquireVerifiedArchive({
        archive: { url: engine.acquisition.url, sha256: engine.acquisition.sha256 },
        cacheRoot,
        maximumBytes,
        fetchImpl,
      }),
    ])
    return {
      name: engine.name,
      version: engine.version,
      license: engine.license,
      sourceArchive,
      acquisition: {
        kind: engine.acquisition.kind,
        cellar: engine.acquisition.cellar,
        archive: runtimeArchive,
      },
    }
  }))
  return {
    target: selected.target,
    homebrewCoreRevision: selected.homebrewCoreRevision,
    homebrewCaskRevision: selected.homebrewCaskRevision,
    engines,
  }
}

export async function acquireConverterSources({ lockPath, target, cacheRoot, maximumBytes, fetchImpl = globalThis.fetch }) {
  const selected = await loadConverterSourceLock({ path: lockPath, target })
  return acquireSelectedConverterSources({ selected, cacheRoot, maximumBytes, fetchImpl })
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const args = parseArguments(process.argv.slice(2), ['--lock', '--target', '--cache'])
  const acquired = await acquireConverterSources({
    lockPath: args['--lock'],
    target: args['--target'],
    cacheRoot: args['--cache'],
  })
  process.stdout.write(`acquired ${acquired.engines.length} converter engine sources for ${acquired.target}\n`)
}
