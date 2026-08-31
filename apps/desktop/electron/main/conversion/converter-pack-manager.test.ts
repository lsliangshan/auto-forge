import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFileSync, watch } from 'node:fs'
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import type { RequestListener } from 'node:http'
import { createServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ConverterPackManager,
  type ConverterPackManagerOptions,
  type ConverterPackSequencePersistence,
} from './converter-pack-manager.js'
import type {
  ConverterPackEntry,
  ConverterPackIndex,
  ConverterPackReference,
  SignedConverterPackIndex,
} from './converter-pack-types.js'

const execFileAsync = promisify(execFile)
const mediaFixtureDirectory = new URL('../media/test-fixtures/', import.meta.url)
const tlsKey = readFileSync(new URL('pinned-media-test-key.pem', mediaFixtureDirectory))
const tlsCert = readFileSync(new URL('pinned-media-test-cert.pem', mediaFixtureDirectory))
const fixtureTool = fileURLToPath(new URL('../../../scripts/converter-packs/create-test-pack.mjs', import.meta.url))
const fixturePublicKey = new URL('./fixtures/test-converter-root-public-key.pem', import.meta.url)

interface TarEntry {
  path: string
  bytes?: Buffer
  mode?: number
  type?: '0' | '1' | '2'
  linkName?: string
  magic?: string
  version?: string
}

const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections?.()
  })))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(prefix = 'autoforge-pack-test-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function listen(listener: RequestListener): Promise<{ server: Server; port: number }> {
  const server = createServer({ key: tlsKey, cert: tlsCert }, listener)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture HTTPS server has no port')
  return { server, port: address.port }
}

function writeString(block: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value)
  if (bytes.byteLength > length) throw new Error('TAR fixture field too long')
  bytes.copy(block, offset)
}

function writeOctal(block: Buffer, offset: number, length: number, value: number): void {
  writeString(block, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`)
}

function tar(entries: readonly TarEntry[]): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const bytes = entry.bytes ?? Buffer.alloc(0)
    const block = Buffer.alloc(512)
    writeString(block, 0, 100, entry.path)
    writeOctal(block, 100, 8, entry.mode ?? 0o755)
    writeOctal(block, 108, 8, 0)
    writeOctal(block, 116, 8, 0)
    writeOctal(block, 124, 12, bytes.byteLength)
    writeOctal(block, 136, 12, 0)
    block.fill(0x20, 148, 156)
    writeString(block, 156, 1, entry.type ?? '0')
    writeString(block, 157, 100, entry.linkName ?? '')
    writeString(block, 257, 6, entry.magic ?? 'ustar\0')
    writeString(block, 263, 2, entry.version ?? '00')
    const checksum = block.reduce((sum, value) => sum + value, 0)
    writeString(block, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
    chunks.push(block, bytes)
    const padding = (512 - (bytes.byteLength % 512)) % 512
    if (padding > 0) chunks.push(Buffer.alloc(padding))
  }
  chunks.push(Buffer.alloc(1_024))
  return Buffer.concat(chunks)
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map(([key, child]) => [key, sortJson(child)]))
}

function canonicalFixtureBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(sortJson(value)), 'utf8')
}

function signedIndex(input: {
  archive: Buffer
  archiveUrl: string
  publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']
  sequence?: number
  version?: string
  entries?: ConverterPackEntry[]
  archiveBytes?: number
  archiveSha256?: string
}): SignedConverterPackIndex {
  const executable = Buffer.from('fixture executable\n')
  const index: ConverterPackIndex = {
    schemaVersion: 1,
    generatedAt: '2026-08-29T00:00:00.000Z',
    sequence: input.sequence ?? 1,
    packs: [{
      name: 'image-icon',
      version: input.version ?? '1.0.0',
      platform: 'darwin',
      arch: 'arm64',
      archiveUrl: input.archiveUrl,
      archiveSha256: input.archiveSha256 ?? sha256(input.archive),
      archiveBytes: input.archiveBytes ?? input.archive.byteLength,
      entries: input.entries ?? [{
        path: 'bin/tool', sha256: sha256(executable), bytes: executable.byteLength, executable: true, role: 'executable',
      }],
    }],
  }
  return {
    index,
    signature: sign(null, canonicalFixtureBytes(index), input.privateKey).toString('base64'),
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function manager(
  packsRoot: string,
  publicKeyPem: string | Buffer,
  overrides: Omit<Partial<ConverterPackManagerOptions>, 'packsRoot' | 'rootPublicKeyPem' | 'platform' | 'arch' | 'tlsCa'> = {},
): ConverterPackManager {
  return new ConverterPackManager({
    ...overrides,
    packsRoot,
    rootPublicKeyPem: publicKeyPem,
    platform: 'darwin',
    arch: 'arm64',
    tlsCa: tlsCert,
  })
}

function reference(version: string): ConverterPackReference {
  return { name: 'image-icon', version, platform: 'darwin', arch: 'arm64' }
}

describe('ConverterPackManager download and installation', () => {
  it('keeps a partial install invisible until same-filesystem atomic rename publishes it', async () => {
    const packsRoot = await temporaryRoot()
    const keyPair = generateKeyPairSync('ed25519')
    const executable = Buffer.from('fixture executable\n')
    const archive = tar([{ path: 'bin/tool', bytes: executable }])
    let continueResponse!: () => void
    let requestStarted!: () => void
    const started = new Promise<void>((resolve) => { requestStarted = resolve })
    const responseGate = new Promise<void>((resolve) => { continueResponse = resolve })
    const { port } = await listen(async (_request, response) => {
      response.writeHead(200, { 'content-length': String(archive.byteLength) })
      response.write(archive.subarray(0, 512))
      requestStarted()
      await responseGate
      response.end(archive.subarray(512))
    })
    const signed = signedIndex({
      archive, archiveUrl: `https://127.0.0.1:${port}/pack.tar`, ...keyPair,
    })
    const packManager = manager(packsRoot, keyPair.publicKey.export({ type: 'spki', format: 'pem' }))

    const acquiring = packManager.acquire({ signedIndex: signed, name: 'image-icon', version: '1.0.0' })
    await started
    expect((await readdir(packsRoot)).filter((name) => /^\.partial-[0-9a-f-]{36}$/u.test(name))).toHaveLength(1)
    expect(await exists(join(packsRoot, 'image-icon/1.0.0/darwin-arm64'))).toBe(false)

    continueResponse()
    const lease = await acquiring
    expect(await readFile(lease.executables['bin/tool']!)).toEqual(executable)
    expect(Object.isFrozen(lease)).toBe(true)
    expect(Object.isFrozen(lease.executables)).toBe(true)
    expect((await readdir(packsRoot)).some((name) => name.startsWith('.partial-'))).toBe(false)
    expect(await realpath(join(packsRoot, 'image-icon/1.0.0/darwin-arm64'))).toBe(lease.root)
    lease.release()
  })

  it('rejects archive and entry hash mismatches without publishing a final directory', async () => {
    const packsRoot = await temporaryRoot()
    const keyPair = generateKeyPairSync('ed25519')
    const executable = Buffer.from('fixture executable\n')
    const archive = tar([{ path: 'bin/tool', bytes: executable }])
    const { port } = await listen((_request, response) => {
      response.writeHead(200, { 'content-length': String(archive.byteLength) })
      response.end(archive)
    })
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' })
    const archiveMismatch = signedIndex({
      archive, archiveUrl: `https://127.0.0.1:${port}/archive.tar`, archiveSha256: '0'.repeat(64), ...keyPair,
    })
    await expect(manager(packsRoot, publicKey).acquire({
      signedIndex: archiveMismatch, name: 'image-icon', version: '1.0.0',
    })).rejects.toMatchObject({ reason: 'archive_hash_mismatch' })

    const entryMismatch = signedIndex({
      archive,
      archiveUrl: `https://127.0.0.1:${port}/entry.tar`,
      entries: [{ path: 'bin/tool', sha256: '0'.repeat(64), bytes: executable.byteLength, executable: true, role: 'executable' }],
      ...keyPair,
    })
    await expect(manager(packsRoot, publicKey).acquire({
      signedIndex: entryMismatch, name: 'image-icon', version: '1.0.0',
    })).rejects.toMatchObject({ reason: 'entry_hash_mismatch' })
    expect(await exists(join(packsRoot, 'image-icon/1.0.0/darwin-arm64'))).toBe(false)
  })

  it.each([
    ['absolute', '/tmp/escape'],
    ['traversal', '../escape'],
    ['non-normal', 'bin/../escape'],
    ['Windows separator', 'bin\\escape'],
    ['drive separator', 'C:/escape'],
    ['trailing dot', 'bin/tool.'],
    ['trailing space', 'bin/tool '],
    ['Windows-forbidden', 'bin/tool?.exe'],
    ['control-character', 'bin/\u0001tool'],
    ['non-portable Unicode', 'bin/étool'],
  ])('rejects a %s archive entry path before writing it', async (_label, maliciousPath) => {
    const packsRoot = await temporaryRoot()
    const keyPair = generateKeyPairSync('ed25519')
    const executable = Buffer.from('fixture executable\n')
    const archive = tar([
      { path: maliciousPath, bytes: Buffer.from('escape'), mode: 0o644 },
      { path: 'bin/tool', bytes: executable },
    ])
    const { port } = await listen((_request, response) => response.end(archive))
    const signed = signedIndex({ archive, archiveUrl: `https://127.0.0.1:${port}/pack.tar`, ...keyPair })
    await expect(manager(packsRoot, keyPair.publicKey.export({ type: 'spki', format: 'pem' })).acquire({
      signedIndex: signed, name: 'image-icon', version: '1.0.0',
    })).rejects.toMatchObject({ reason: 'archive_entry_invalid' })
    expect(await exists(join(packsRoot, 'image-icon/1.0.0/darwin-arm64'))).toBe(false)
  })

  it.each([
    ['symbolic link', '2' as const],
    ['hard link', '1' as const],
  ])('rejects a %s archive entry', async (_label, type) => {
    const packsRoot = await temporaryRoot()
    const keyPair = generateKeyPairSync('ed25519')
    const archive = tar([{ path: 'bin/tool', type, linkName: '../victim' }])
    const { port } = await listen((_request, response) => response.end(archive))
    const signed = signedIndex({ archive, archiveUrl: `https://127.0.0.1:${port}/pack.tar`, ...keyPair })
    await expect(manager(packsRoot, keyPair.publicKey.export({ type: 'spki', format: 'pem' })).acquire({
      signedIndex: signed, name: 'image-icon', version: '1.0.0',
    })).rejects.toMatchObject({ reason: 'archive_entry_invalid' })
  })

  it.each([
    ['invalid USTAR magic', { magic: 'notar\0' }],
    ['invalid USTAR version', { version: '99' }],
    ['mode with file-type bits', { mode: 0o100755 }],
  ])('rejects %s', async (_label, headerOverride) => {
    const packsRoot = await temporaryRoot()
    const keyPair = generateKeyPairSync('ed25519')
    const executable = Buffer.from('fixture executable\n')
    const archive = tar([{ path: 'bin/tool', bytes: executable, ...headerOverride }])
    const { port } = await listen((_request, response) => response.end(archive))
    const signed = signedIndex({ archive, archiveUrl: `https://127.0.0.1:${port}/pack.tar`, ...keyPair })
    await expect(manager(packsRoot, keyPair.publicKey.export({ type: 'spki', format: 'pem' })).acquire({
      signedIndex: signed, name: 'image-icon', version: '1.0.0',
    })).rejects.toMatchObject({ reason: 'archive_entry_invalid' })
  })

  it('rejects duplicate, undeclared, and extra-executable archive entries', async () => {
    const keyPair = generateKeyPairSync('ed25519')
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' })
    const executable = Buffer.from('fixture executable\n')
    const archives = [
      tar([{ path: 'bin/tool', bytes: executable }, { path: 'BIN/TOOL', bytes: executable }]),
      tar([{ path: 'bin/extra', bytes: executable }]),
      tar([{ path: 'bin/tool', bytes: executable, mode: 0o755 }]),
    ]
    const entries: ConverterPackEntry[][] = [
      [{ path: 'bin/tool', sha256: sha256(executable), bytes: executable.byteLength, executable: true, role: 'executable' }],
      [{ path: 'bin/tool', sha256: sha256(executable), bytes: executable.byteLength, executable: true, role: 'executable' }],
      [{ path: 'bin/tool', sha256: sha256(executable), bytes: executable.byteLength, executable: false, role: 'data' }],
    ]
    for (let index = 0; index < archives.length; index += 1) {
      const packsRoot = await temporaryRoot()
      const archive = archives[index]!
      const { port } = await listen((_request, response) => response.end(archive))
      const signed = signedIndex({
        archive, archiveUrl: `https://127.0.0.1:${port}/pack.tar`, entries: entries[index], ...keyPair,
      })
      await expect(manager(packsRoot, publicKey).acquire({
        signedIndex: signed, name: 'image-icon', version: '1.0.0',
      })).rejects.toMatchObject({ reason: 'archive_entry_invalid' })
    }
  })

  it('enforces Content-Length and actual byte caps', async () => {
    const keyPair = generateKeyPairSync('ed25519')
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' })
    const archive = tar([{ path: 'bin/tool', bytes: Buffer.from('fixture executable\n') }])
    const wrongLengthServer = await listen((_request, response) => {
      response.writeHead(200, { 'content-length': String(archive.byteLength + 1) })
      response.end(archive)
    })
    const wrongLength = signedIndex({
      archive, archiveUrl: `https://127.0.0.1:${wrongLengthServer.port}/pack.tar`, ...keyPair,
    })
    await expect(manager(await temporaryRoot(), publicKey).acquire({
      signedIndex: wrongLength, name: 'image-icon', version: '1.0.0',
    })).rejects.toMatchObject({ reason: 'archive_size_mismatch' })

    const chunkedServer = await listen((_request, response) => {
      response.writeHead(200, { 'transfer-encoding': 'chunked' })
      response.write(archive.subarray(0, 512))
      response.end(archive.subarray(512))
    })
    const tooManyActualBytes = signedIndex({
      archive,
      archiveUrl: `https://127.0.0.1:${chunkedServer.port}/pack.tar`,
      archiveBytes: archive.byteLength - 1,
      ...keyPair,
    })
    await expect(manager(await temporaryRoot(), publicKey).acquire({
      signedIndex: tooManyActualBytes, name: 'image-icon', version: '1.0.0',
    })).rejects.toMatchObject({ reason: 'archive_size_mismatch' })
  })

  it('rejects interrupted downloads and removes the exact partial directory', async () => {
    const packsRoot = await temporaryRoot()
    const keyPair = generateKeyPairSync('ed25519')
    const archive = tar([{ path: 'bin/tool', bytes: Buffer.from('fixture executable\n') }])
    const { port } = await listen((_request, response) => {
      response.writeHead(200, { 'content-length': String(archive.byteLength) })
      response.write(archive.subarray(0, 600))
      response.socket?.destroy()
    })
    const signed = signedIndex({ archive, archiveUrl: `https://127.0.0.1:${port}/pack.tar`, ...keyPair })
    await expect(manager(packsRoot, keyPair.publicKey.export({ type: 'spki', format: 'pem' })).acquire({
      signedIndex: signed, name: 'image-icon', version: '1.0.0',
    })).rejects.toMatchObject({ reason: 'download_failed' })
    expect((await readdir(packsRoot)).some((name) => name.startsWith('.partial-'))).toBe(false)
    expect(await exists(join(packsRoot, 'image-icon/1.0.0/darwin-arm64'))).toBe(false)
  })

  it('permits only HTTPS redirects and bounds their count', async () => {
    const keyPair = generateKeyPairSync('ed25519')
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' })
    const archive = tar([{ path: 'bin/tool', bytes: Buffer.from('fixture executable\n') }])
    const insecure = await listen((_request, response) => {
      response.writeHead(302, { location: 'http://127.0.0.1/pack.tar' })
      response.end()
    })
    const insecureIndex = signedIndex({ archive, archiveUrl: `https://127.0.0.1:${insecure.port}/pack.tar`, ...keyPair })
    await expect(manager(await temporaryRoot(), publicKey).acquire({
      signedIndex: insecureIndex, name: 'image-icon', version: '1.0.0',
    })).rejects.toMatchObject({ reason: 'redirect_invalid' })

    let redirectPort = 0
    const redirect = await listen((_request, response) => {
      response.writeHead(302, { location: `https://127.0.0.1:${redirectPort}/loop` })
      response.end()
    })
    redirectPort = redirect.port
    const loopIndex = signedIndex({ archive, archiveUrl: `https://127.0.0.1:${redirect.port}/loop`, ...keyPair })
    await expect(manager(await temporaryRoot(), publicKey, { maxRedirects: 2 }).acquire({
      signedIndex: loopIndex, name: 'image-icon', version: '1.0.0',
    })).rejects.toMatchObject({ reason: 'redirect_limit' })
  })

  it('single-flights concurrent acquisition of the same signed pack', async () => {
    const packsRoot = await temporaryRoot()
    const keyPair = generateKeyPairSync('ed25519')
    const archive = tar([{ path: 'bin/tool', bytes: Buffer.from('fixture executable\n') }])
    let requests = 0
    const { port } = await listen((_request, response) => {
      requests += 1
      setTimeout(() => response.end(archive), 10)
    })
    const signed = signedIndex({ archive, archiveUrl: `https://127.0.0.1:${port}/pack.tar`, ...keyPair })
    const packManager = manager(packsRoot, keyPair.publicKey.export({ type: 'spki', format: 'pem' }))
    const [first, second] = await Promise.all([
      packManager.acquire({ signedIndex: signed, name: 'image-icon', version: '1.0.0' }),
      packManager.acquire({ signedIndex: signed, name: 'image-icon', version: '1.0.0' }),
    ])
    expect(requests).toBe(1)
    expect(first).not.toBe(second)
    expect(first.root).toBe(second.root)
    first.release()
    second.release()
  })

  it('persists the highest signed sequence and rejects rollback after manager restart', async () => {
    const packsRoot = await temporaryRoot()
    const keyPair = generateKeyPairSync('ed25519')
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' })
    const archive = tar([{ path: 'bin/tool', bytes: Buffer.from('fixture executable\n') }])
    const { port } = await listen((_request, response) => response.end(archive))
    const current = signedIndex({
      archive, archiveUrl: `https://127.0.0.1:${port}/pack.tar`, sequence: 8, ...keyPair,
    })
    const lease = await manager(packsRoot, publicKey).acquire({ signedIndex: current, name: 'image-icon', version: '1.0.0' })
    lease.release()

    const rollback = signedIndex({
      archive, archiveUrl: `https://127.0.0.1:${port}/pack.tar`, sequence: 7, ...keyPair,
    })
    await expect(manager(packsRoot, publicKey).acquire({
      signedIndex: rollback, name: 'image-icon', version: '1.0.0',
    })).rejects.toMatchObject({ reason: 'index_rollback' })
  })

  it('persists a sequence through file sync, atomic rename, then directory sync', async () => {
    const packsRoot = await temporaryRoot()
    const keyPair = generateKeyPairSync('ed25519')
    const archive = tar([{ path: 'bin/tool', bytes: Buffer.from('fixture executable\n') }])
    const { port } = await listen((_request, response) => response.end(archive))
    const sequenceRoot = join(await realpath(packsRoot), '.index-sequences')
    const events: string[] = []
    let temporaryPath = ''
    const sequencePersistence: ConverterPackSequencePersistence = {
      openExclusive: async (path) => {
        expect(dirname(path)).toBe(sequenceRoot)
        expect(path).toMatch(/\/\.sequence-8\.partial-[0-9a-f-]{36}$/u)
        temporaryPath = path
        events.push('open')
        return {
          write: async (value) => {
            expect(value).toBe('8\n')
            events.push('write')
          },
          sync: async () => { events.push('sync-file') },
          close: async () => { events.push('close-file') },
        }
      },
      rename: async (source, destination) => {
        expect(source).toBe(temporaryPath)
        expect(destination).toBe(join(sequenceRoot, '8'))
        events.push('rename')
      },
      syncDirectory: async (path) => {
        expect(path).toBe(sequenceRoot)
        events.push('sync-directory')
      },
    }
    const signed = signedIndex({
      archive, archiveUrl: `https://127.0.0.1:${port}/pack.tar`, sequence: 8, ...keyPair,
    })
    const lease = await manager(
      packsRoot,
      keyPair.publicKey.export({ type: 'spki', format: 'pem' }),
      { sequencePersistence },
    ).acquire({ signedIndex: signed, name: 'image-icon', version: '1.0.0' })
    lease.release()
    expect(events).toEqual(['open', 'write', 'sync-file', 'close-file', 'rename', 'sync-directory'])
  })

  it('serializes sequence persistence across managers sharing one root', async () => {
    const packsRoot = await temporaryRoot()
    const keyPair = generateKeyPairSync('ed25519')
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' })
    const archive = tar([{ path: 'bin/tool', bytes: Buffer.from('fixture executable\n') }])
    const { port } = await listen((_request, response) => response.end(archive))
    let reachedRename!: () => void
    let allowRename!: () => void
    const renameReached = new Promise<void>((resolve) => { reachedRename = resolve })
    const renameGate = new Promise<void>((resolve) => { allowRename = resolve })
    const highPersistence: ConverterPackSequencePersistence = {
      openExclusive: async (path) => {
        const handle = await open(path, 'wx', 0o600)
        return {
          write: async (value) => { await handle.writeFile(value, 'utf8') },
          sync: async () => { await handle.sync() },
          close: async () => { await handle.close() },
        }
      },
      rename: async (source, destination) => {
        reachedRename()
        await renameGate
        await rename(source, destination)
      },
      syncDirectory: async (path) => {
        const handle = await open(path, 'r')
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
      },
    }
    const highManager = manager(packsRoot, publicKey, { sequencePersistence: highPersistence })
    const lowManager = manager(packsRoot, publicKey)
    await Promise.all([highManager.initialize(), lowManager.initialize()])
    const high = signedIndex({
      archive, archiveUrl: `https://127.0.0.1:${port}/high.tar`, sequence: 8, version: '8.0.0', ...keyPair,
    })
    const low = signedIndex({
      archive, archiveUrl: `https://127.0.0.1:${port}/low.tar`, sequence: 7, version: '7.0.0', ...keyPair,
    })

    const highAcquiring = highManager.acquire({ signedIndex: high, name: 'image-icon', version: '8.0.0' })
    await renameReached
    const lowAcquiring = lowManager.acquire({ signedIndex: low, name: 'image-icon', version: '7.0.0' })
    const lowRejected = expect(lowAcquiring).rejects.toMatchObject({ reason: 'index_rollback' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    allowRename()

    const highLease = await highAcquiring
    highLease.release()
    await lowRejected
  })

  it('cleans an exact stale sequence temp and still rejects below a committed marker', async () => {
    const packsRoot = await temporaryRoot()
    const sequenceRoot = join(packsRoot, '.index-sequences')
    const staleTemp = join(sequenceRoot, '.sequence-9.partial-123e4567-e89b-42d3-a456-426614174000')
    await mkdir(sequenceRoot, { recursive: true })
    await writeFile(join(sequenceRoot, '8'), '8\n')
    await writeFile(staleTemp, '9\n')
    const keyPair = generateKeyPairSync('ed25519')
    const archive = tar([{ path: 'bin/tool', bytes: Buffer.from('fixture executable\n') }])
    const { port } = await listen((_request, response) => response.end(archive))
    const rollback = signedIndex({
      archive, archiveUrl: `https://127.0.0.1:${port}/pack.tar`, sequence: 7, ...keyPair,
    })
    await expect(manager(packsRoot, keyPair.publicKey.export({ type: 'spki', format: 'pem' })).acquire({
      signedIndex: rollback, name: 'image-icon', version: '1.0.0',
    })).rejects.toMatchObject({ reason: 'index_rollback' })
    expect(await exists(staleTemp)).toBe(false)
  })
})

describe('ConverterPackManager cleanup and fixture tooling', () => {
  it('startup removes only exact partial UUID entries without following symlinks', async () => {
    const packsRoot = await temporaryRoot()
    const outside = await temporaryRoot('autoforge-pack-outside-')
    const exactPartial = join(packsRoot, '.partial-123e4567-e89b-42d3-a456-426614174000')
    const linkedPartial = join(packsRoot, '.partial-123e4567-e89b-42d3-a456-426614174001')
    const suspicious = join(packsRoot, '.partial-not-a-uuid')
    const installed = join(packsRoot, 'image-icon/1.0.0/darwin-arm64')
    await mkdir(exactPartial, { recursive: true })
    await mkdir(suspicious, { recursive: true })
    await mkdir(installed, { recursive: true })
    await writeFile(join(outside, 'keep'), 'outside')
    await symlink(outside, linkedPartial)
    const keyPair = generateKeyPairSync('ed25519')

    await manager(packsRoot, keyPair.publicKey.export({ type: 'spki', format: 'pem' })).initialize()
    expect(await exists(exactPartial)).toBe(false)
    expect(await exists(linkedPartial)).toBe(false)
    expect(await exists(join(outside, 'keep'))).toBe(true)
    expect(await exists(suspicious)).toBe(true)
    expect(await exists(installed)).toBe(true)
  })

  it('does not remove active, current, job-referenced, or retained previous versions', async () => {
    const packsRoot = await temporaryRoot()
    const keyPair = generateKeyPairSync('ed25519')
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' })
    const archive = tar([{ path: 'bin/tool', bytes: Buffer.from('fixture executable\n') }])
    const { port } = await listen((_request, response) => response.end(archive))
    const packManager = manager(packsRoot, publicKey)
    const leases = []
    for (const [index, version] of ['1.0.0', '2.0.0', '3.0.0'].entries()) {
      const signed = signedIndex({
        archive,
        archiveUrl: `https://127.0.0.1:${port}/${version}.tar`,
        sequence: index + 1,
        version,
        ...keyPair,
      })
      leases.push(await packManager.acquire({ signedIndex: signed, name: 'image-icon', version }))
    }
    leases[1]!.release()
    leases[2]!.release()

    await packManager.cleanup({ jobReferences: [reference('2.0.0')] })
    for (const version of ['1.0.0', '2.0.0', '3.0.0']) {
      expect(await exists(join(packsRoot, `image-icon/${version}/darwin-arm64`))).toBe(true)
    }

    leases[0]!.release()
    await packManager.cleanup()
    expect(await exists(join(packsRoot, 'image-icon/1.0.0/darwin-arm64'))).toBe(false)
    expect(await exists(join(packsRoot, 'image-icon/1.0.0'))).toBe(false)
    expect(await exists(join(packsRoot, 'image-icon/2.0.0/darwin-arm64'))).toBe(true)
    expect(await exists(join(packsRoot, 'image-icon/3.0.0/darwin-arm64'))).toBe(true)
  })

  it('retains stable hyphenated build metadata as current and the highest prerelease as previous', async () => {
    const packsRoot = await temporaryRoot()
    const keyPair = generateKeyPairSync('ed25519')
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' })
    const archive = tar([{ path: 'bin/tool', bytes: Buffer.from('fixture executable\n') }])
    const { port } = await listen((_request, response) => response.end(archive))
    const packManager = manager(packsRoot, publicKey)
    const versions = ['1.0.0+build-1', '1.0.0-rc.1', '1.0.0-rc.2']
    for (const [index, version] of versions.entries()) {
      const signed = signedIndex({
        archive,
        archiveUrl: `https://127.0.0.1:${port}/${encodeURIComponent(version)}.tar`,
        sequence: index + 1,
        version,
        ...keyPair,
      })
      const lease = await packManager.acquire({ signedIndex: signed, name: 'image-icon', version })
      lease.release()
    }

    await packManager.cleanup()
    expect(await exists(join(packsRoot, 'image-icon/1.0.0+build-1/darwin-arm64'))).toBe(true)
    expect(await exists(join(packsRoot, 'image-icon/1.0.0-rc.2/darwin-arm64'))).toBe(true)
    expect(await exists(join(packsRoot, 'image-icon/1.0.0-rc.1/darwin-arm64'))).toBe(false)
  })

  it('does not remove a version whose acquire becomes active during cleanup', async () => {
    const packsRoot = await temporaryRoot()
    const keyPair = generateKeyPairSync('ed25519')
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' })
    const archive = tar([{ path: 'bin/tool', bytes: Buffer.from('fixture executable\n') }])
    const { port } = await listen((_request, response) => response.end(archive))
    const packManager = manager(packsRoot, publicKey)
    let oldSigned!: SignedConverterPackIndex
    for (const [index, version] of ['1.0.0', '2.0.0', '3.0.0'].entries()) {
      const signed = signedIndex({
        archive,
        archiveUrl: `https://127.0.0.1:${port}/${version}.tar`,
        sequence: index + 1,
        version,
        ...keyPair,
      })
      const lease = await packManager.acquire({ signedIndex: signed, name: 'image-icon', version })
      lease.release()
      if (version === '1.0.0') oldSigned = signedIndex({
        archive,
        archiveUrl: `https://127.0.0.1:${port}/${version}-again.tar`,
        sequence: 4,
        version,
        ...keyPair,
      })
    }

    const slowStaleRoot = join(packsRoot, 'image-icon/0.9.0/darwin-arm64')
    await mkdir(slowStaleRoot, { recursive: true })
    const files = Array.from({ length: 2_000 }, (_, index) => join(slowStaleRoot, `stale-${index}`))
    await Promise.all(files.map((path) => writeFile(path, 'stale')))
    let deletionStarted!: () => void
    const started = new Promise<void>((resolve) => { deletionStarted = resolve })
    const watcher = watch(slowStaleRoot, () => deletionStarted())
    const cleaning = packManager.cleanup()
    await started
    const leasing = packManager.acquire({ signedIndex: oldSigned, name: 'image-icon', version: '1.0.0' })
    const [lease] = await Promise.all([leasing, cleaning.then(() => undefined)])
    watcher.close()
    expect(await exists(lease.root)).toBe(true)
    expect(await readFile(lease.executables['bin/tool']!, 'utf8')).toBe('fixture executable\n')
    lease.release()
  })

  it('fixture pack tool emits only a local-test signed pack and no private key', async () => {
    const output = await temporaryRoot('autoforge-pack-tool-')
    await execFileAsync(process.execPath, [
      fixtureTool,
      '--output', output,
      '--archive-url', 'https://127.0.0.1:44321/image-icon.tar',
      '--name', 'image-icon',
      '--version', '1.0.0-test.1',
      '--platform', 'darwin',
      '--arch', 'arm64',
      '--sequence', '1',
    ])
    const names = (await readdir(output)).sort()
    expect(names).toEqual(['index.json', 'index.sig', 'pack.tar'])
    expect(names.some((name) => /private|secret|\.key$/iu.test(name))).toBe(false)
    const index = JSON.parse(await readFile(join(output, 'index.json'), 'utf8')) as ConverterPackIndex
    const signature = (await readFile(join(output, 'index.sig'), 'utf8')).trim()
    const publicKeyPem = await readFile(fixturePublicKey)
    const verifierRoot = dirname(fileURLToPath(fixturePublicKey))
    expect(verifierRoot.endsWith('/conversion/fixtures')).toBe(true)
    const archive = await readFile(join(output, 'pack.tar'))
    expect(index.packs[0]).toMatchObject({
      archiveUrl: 'https://127.0.0.1:44321/image-icon.tar',
      archiveBytes: archive.byteLength,
      archiveSha256: sha256(archive),
    })
    const packManager = manager(await temporaryRoot(), publicKeyPem)
    await expect(packManager.acquire({ signedIndex: { index, signature }, name: 'image-icon', version: '1.0.0-test.1' }))
      .rejects.toMatchObject({ reason: 'download_failed' })
  })

  it('copies a Buffer root at construction so the pinned key cannot be mutated by its caller', async () => {
    const packsRoot = await temporaryRoot()
    const keyPair = generateKeyPairSync('ed25519')
    const publicKey = Buffer.from(keyPair.publicKey.export({ type: 'spki', format: 'pem' }))
    const archive = tar([{ path: 'bin/tool', bytes: Buffer.from('fixture executable\n') }])
    const { port } = await listen((_request, response) => response.end(archive))
    const signed = signedIndex({ archive, archiveUrl: `https://127.0.0.1:${port}/pack.tar`, ...keyPair })
    const packManager = manager(packsRoot, publicKey)
    publicKey.fill(0)

    const lease = await packManager.acquire({ signedIndex: signed, name: 'image-icon', version: '1.0.0' })
    expect(await readFile(lease.executables['bin/tool']!, 'utf8')).toBe('fixture executable\n')
    lease.release()
  })

  it('revalidates a preinstalled executable before leasing it', async () => {
    const packsRoot = await temporaryRoot()
    const keyPair = generateKeyPairSync('ed25519')
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' })
    const executable = Buffer.from('fixture executable\n')
    const archive = tar([{ path: 'bin/tool', bytes: executable }])
    const { port } = await listen((_request, response) => response.end(archive))
    const signed = signedIndex({ archive, archiveUrl: `https://127.0.0.1:${port}/pack.tar`, ...keyPair })
    const packManager = manager(packsRoot, publicKey)
    const first = await packManager.acquire({ signedIndex: signed, name: 'image-icon', version: '1.0.0' })
    first.release()
    await chmod(first.executables['bin/tool']!, 0o755)
    await writeFile(first.executables['bin/tool']!, 'tampered executable\n')
    await expect(packManager.acquire({ signedIndex: signed, name: 'image-icon', version: '1.0.0' }))
      .rejects.toMatchObject({ reason: 'installed_pack_invalid' })
  })

  it('rejects a preinstalled pack whose version ancestor is a symlink outside the managed root', async () => {
    const packsRoot = await temporaryRoot()
    const outside = await temporaryRoot('autoforge-pack-external-install-')
    const keyPair = generateKeyPairSync('ed25519')
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' })
    const executable = Buffer.from('fixture executable\n')
    const archive = tar([{ path: 'bin/tool', bytes: executable }])
    const { port } = await listen((_request, response) => response.end(archive))
    const signed = signedIndex({ archive, archiveUrl: `https://127.0.0.1:${port}/pack.tar`, ...keyPair })
    await mkdir(join(packsRoot, 'image-icon'), { recursive: true })
    await mkdir(join(outside, 'darwin-arm64/bin'), { recursive: true })
    await writeFile(join(outside, 'darwin-arm64/bin/tool'), executable)
    await chmod(join(outside, 'darwin-arm64/bin/tool'), 0o755)
    await symlink(outside, join(packsRoot, 'image-icon/1.0.0'))

    await expect(manager(packsRoot, publicKey).acquire({
      signedIndex: signed, name: 'image-icon', version: '1.0.0',
    })).rejects.toMatchObject({ reason: 'installed_pack_invalid' })
  })
})
