import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync, deflateSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { createKnowledgeParserProcess } from '../../cloudbase/knowledge/worker/parser-process.js'
import {
  createKnowledgeParser,
  createKnowledgeWorker,
  createWorkerStorageClient,
} from '../../cloudbase/knowledge/worker/knowledge-worker.js'

const claim = (id: string, kind: 'upload' | 'embedding' | 'purge', attempt = 1) => ({
  job: { id, kind, entityId: `${kind}_entity`, leaseToken: `lease_${id}`, attempt },
})

async function withParserChild<T>(source: string, run: (path: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'autoforge-parser-child-'))
  const path = join(directory, 'child.cjs')
  await writeFile(path, source, 'utf8')
  try {
    return await run(path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function docxDirectoryFixture(compressedBytes: number, expandedBytes: number): Buffer {
  const name = Buffer.from('word/document.xml')
  const central = Buffer.alloc(46 + name.byteLength)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(compressedBytes, 20)
  central.writeUInt32LE(expandedBytes, 24)
  central.writeUInt16LE(name.byteLength, 28)
  name.copy(central, 46)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.byteLength, 12)
  end.writeUInt32LE(0, 16)
  return Buffer.concat([central, end])
}

function docxArchiveFixture(
  source: Buffer,
  declaredExpanded = source.byteLength,
  entryName = 'word/document.xml',
): Buffer {
  const name = Buffer.from(entryName)
  const compressed = deflateRawSync(source)
  const local = Buffer.alloc(30 + name.byteLength)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(compressed.byteLength, 18)
  local.writeUInt32LE(declaredExpanded, 22)
  local.writeUInt16LE(name.byteLength, 26)
  name.copy(local, 30)
  const central = Buffer.alloc(46 + name.byteLength)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(compressed.byteLength, 20)
  central.writeUInt32LE(declaredExpanded, 24)
  central.writeUInt16LE(name.byteLength, 28)
  name.copy(central, 46)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.byteLength, 12)
  end.writeUInt32LE(local.byteLength + compressed.byteLength, 16)
  return Buffer.concat([local, compressed, central, end])
}

function pdfFixture(text: string, expandedPaddingBytes = 0): Buffer {
  const content = Buffer.concat([
    Buffer.alloc(expandedPaddingBytes, 0x20),
    Buffer.from(`BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/gu, '\\$&')}) Tj ET`, 'ascii'),
  ])
  const stream = deflateSync(content)
  content.fill(0)
  const objects = [
    Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', 'ascii'),
    Buffer.from('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n', 'ascii'),
    Buffer.from('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n', 'ascii'),
    Buffer.from('4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n', 'ascii'),
    Buffer.concat([
      Buffer.from(`5 0 obj\n<< /Length ${stream.byteLength} /Filter /FlateDecode >>\nstream\n`, 'ascii'),
      stream,
      Buffer.from('\nendstream\nendobj\n', 'ascii'),
    ]),
  ]
  const header = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')
  const offsets: number[] = []
  let cursor = header.byteLength
  for (const object of objects) {
    offsets.push(cursor)
    cursor += object.byteLength
  }
  const xrefOffset = cursor
  const xref = Buffer.from([
    'xref', '0 6', '0000000000 65535 f ',
    ...offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n `),
    'trailer', '<< /Size 6 /Root 1 0 R >>', 'startxref', String(xrefOffset), '%%EOF', '',
  ].join('\n'), 'ascii')
  return Buffer.concat([header, ...objects, xref])
}

describe('CloudBase knowledge scheduled worker', () => {
  it('ships a directly deployable CommonJS scheduled entry', async () => {
    const [rootEntry, entry, childEntry, parserProcess, packageJson, childPackageJson, deployLock]
      = await Promise.all([
      readFile(new URL('../../cloudbase/knowledge/index.js', import.meta.url), 'utf8'),
      readFile(new URL('../../cloudbase/knowledge/worker/index.js', import.meta.url), 'utf8'),
      readFile(new URL('../../cloudbase/knowledge/worker/parser-child.js', import.meta.url), 'utf8'),
      readFile(new URL('../../cloudbase/knowledge/worker/parser-process.js', import.meta.url), 'utf8'),
      readFile(new URL('../../cloudbase/knowledge/package.json', import.meta.url), 'utf8'),
      readFile(new URL('../../cloudbase/knowledge/worker/package.json', import.meta.url), 'utf8'),
      readFile(new URL('../../cloudbase/knowledge/pnpm-lock.yaml', import.meta.url), 'utf8'),
    ])
    expect(JSON.parse(packageJson)).toMatchObject({
      type: 'commonjs', main: 'index.js', engines: { node: '>=22.13.0 <27' },
      packageManager: 'pnpm@11.15.0',
      dependencies: { mammoth: '1.12.1', 'pdfjs-dist': '6.2.108' },
    })
    expect(JSON.parse(childPackageJson)).toMatchObject({
      type: 'commonjs', main: 'parser-child.js', engines: { node: '>=22.13.0 <27' },
      dependencies: { mammoth: '1.12.1', 'pdfjs-dist': '6.2.108' },
    })
    expect(deployLock).toContain('lockfileVersion:')
    expect(deployLock).toContain('pdfjs-dist@6.2.108')
    expect(deployLock).toContain('patch_hash=')
    expect(deployLock).toContain('mammoth@1.12.1')
    expect(deployLock).not.toContain('pdfjs-dist@3.11.174')
    expect(JSON.parse(packageJson).dependencies).not.toEqual(expect.objectContaining({
      'autoforge-knowledge': expect.anything(),
    }))
    expect(rootEntry).toContain("require('./worker/index.js')")
    expect(rootEntry).toContain('exports.main = main')
    expect(entry).toContain("require('../function/knowledge-handler.js')")
    expect(entry).toContain('exports.main = main')
    expect(entry).toContain('createEmbeddingGenerationWorker')
    expect(entry).toContain('maximumChunksPerRun: 2')
    expect(entry).toContain('createKnowledgeParserProcess')
    expect(entry).not.toContain('createKnowledgeParser()')
    expect(childEntry).not.toMatch(/knowledge-handler|TOKENHUB|PG_SERVICE|STORAGE_BASE|RPC_BASE/u)
    expect(parserProcess).not.toMatch(/knowledge-handler|TOKENHUB|PG_SERVICE|STORAGE_BASE|RPC_BASE/u)
    expect(entry).not.toMatch(/\bexport\s+(?:default|async|function|const|let|var|class)/)
  })

  it('parses each request in a fresh memory-bounded child with a scrubbed environment', async () => {
    const launches: Array<{ command: string, args: readonly string[], options: Record<string, unknown> }> = []
    const parser = createKnowledgeParserProcess({
      timeoutMs: 2_000,
      spawnImpl: (command, args, options) => {
        launches.push({ command, args, options })
        return spawn(command, args, options)
      },
    })
    const previousCredential = process.env.AUTOFORGE_PG_SERVICE_KEY
    process.env.AUTOFORGE_PG_SERVICE_KEY = 'must-not-enter-parser-child'
    try {
      const firstBytes = Buffer.from('第一条\n\n第二条')
      const secondBytes = Buffer.from('第三条')
      const first = await parser.parse({
        bytes: firstBytes, mimeType: 'text/plain', versionId: 'version_1',
      })
      const second = await parser.parse({
        bytes: secondBytes, mimeType: 'text/plain', versionId: 'version_2',
      })

      expect(first.blocks.map(({ body }: { body: string }) => body)).toEqual(['第一条', '第二条'])
      expect(second.blocks.map(({ body }: { body: string }) => body)).toEqual(['第三条'])
      expect(firstBytes.every(byte => byte === 0)).toBe(true)
      expect(secondBytes.every(byte => byte === 0)).toBe(true)
      expect(launches).toHaveLength(2)
      expect(launches[0]?.command).toBe('/usr/bin/sandbox-exec')
      expect(launches[0]?.args).toEqual(expect.arrayContaining([
        '-p',
        expect.stringContaining('(deny network*)'),
        process.execPath,
        '--permission',
        '--no-addons',
        '--max-old-space-size=128',
        expect.stringMatching(/parser-child\.js$/u),
      ]))
      expect(launches[0]?.options).toMatchObject({
        env: { AUTOFORGE_PARSER_CHILD: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      expect(JSON.stringify(launches)).not.toContain('must-not-enter-parser-child')
    } finally {
      if (previousCredential === undefined) delete process.env.AUTOFORGE_PG_SERVICE_KEY
      else process.env.AUTOFORGE_PG_SERVICE_KEY = previousCredential
    }
  })

  it('fails closed before spawn when the runtime has no approved OS sandbox', () => {
    const spawnImpl = vi.fn()
    expect(() => createKnowledgeParserProcess({
      runtimePlatform: 'linux', spawnImpl,
    })).toThrow('Knowledge parser process is not configured')
    expect(() => createKnowledgeParserProcess({
      runtimeNodeVersion: '21.7.3', spawnImpl,
    })).toThrow('Knowledge parser process is not configured')
    expect(() => createKnowledgeParserProcess({
      runtimeNodeVersion: '22.12.0', spawnImpl,
    })).toThrow('Knowledge parser process is not configured')
    expect(() => createKnowledgeParserProcess({
      runtimeNodeVersion: '27.0.0', spawnImpl,
    })).toThrow('Knowledge parser process is not configured')
    expect(spawnImpl).not.toHaveBeenCalled()
  })

  it('denies real network, file, parent-process, child-process, and native-addon syscalls', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'autoforge-parser-sandbox-secret-'))
    const secretPath = join(directory, 'parent-secret.node')
    await writeFile(secretPath, 'parent credential material', 'utf8')
    const tcp = createServer(socket => socket.destroy())
    const udp = createSocket('udp4')
    let tcpConnections = 0
    let udpPackets = 0
    tcp.on('connection', () => { tcpConnections += 1 })
    udp.on('message', () => { udpPackets += 1 })
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        tcp.once('error', reject)
        tcp.listen(0, '127.0.0.1', resolve)
      }),
      new Promise<void>((resolve, reject) => {
        udp.once('error', reject)
        udp.bind(0, '127.0.0.1', resolve)
      }),
    ])
    const tcpPort = (tcp.address() as { port: number }).port
    const udpPort = (udp.address() as { port: number }).port
    try {
      await withParserChild(`
        const fs = require('node:fs')
        const net = require('node:net')
        const http = require('node:http')
        const { Resolver } = require('node:dns').promises
        const childProcess = require('node:child_process')
        const results = { scrubbedEnv: process.env.PARENT_PARSER_SECRET === undefined }
        try { fs.readFileSync(${JSON.stringify(secretPath)}); results.fileDenied = false }
        catch (error) { results.fileDenied = ['ERR_ACCESS_DENIED', 'EPERM', 'EACCES'].includes(error.code) }
        try { fs.readFileSync('/proc/' + process.ppid + '/environ'); results.procDenied = false }
        catch (error) { results.procDenied = ['ERR_ACCESS_DENIED', 'EPERM', 'EACCES', 'ENOENT'].includes(error.code) }
        try { childProcess.spawnSync('/usr/bin/true'); results.childProcessDenied = false }
        catch (error) { results.childProcessDenied = ['ERR_ACCESS_DENIED', 'EPERM', 'EACCES'].includes(error.code) }
        try { process.kill(process.ppid, 0); results.parentSignalDenied = false }
        catch (error) { results.parentSignalDenied = ['EPERM', 'EACCES'].includes(error.code) }
        try { require(${JSON.stringify(secretPath)}); results.nativeAddonDenied = false }
        catch (error) { results.nativeAddonDenied = ['ERR_ACCESS_DENIED', 'ERR_DLOPEN_DISABLED', 'EPERM', 'EACCES'].includes(error.code) }
        const networkAttempt = (start) => new Promise(resolve => {
          let settled = false
          const finish = denied => { if (!settled) { settled = true; resolve(denied) } }
          try { start(finish) } catch { finish(true) }
          setTimeout(() => finish(false), 200)
        })
        async function main() {
          results.netDenied = await networkAttempt(finish => {
            const socket = new net.Socket()
            socket.once('connect', () => { socket.destroy(); finish(false) })
            socket.once('error', () => finish(true))
            socket.connect(${tcpPort}, '127.0.0.1')
          })
          results.httpDenied = await networkAttempt(finish => {
            const request = new http.ClientRequest({ host: '127.0.0.1', port: ${tcpPort}, path: '/' })
            request.once('response', () => finish(false))
            request.once('error', () => finish(true))
            request.end()
          })
          results.dnsDenied = await networkAttempt(finish => {
            const resolver = new Resolver()
            resolver.setServers(['127.0.0.1:${udpPort}'])
            resolver.resolve4('secret.invalid').then(() => finish(false), () => finish(true))
          })
          const body = Buffer.from(JSON.stringify({ ok: true, result: results }))
          const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length)
          process.stdout.write(Buffer.concat([prefix, body]))
        }
        process.stdin.resume()
        process.stdin.on('end', () => void main())
      `, async (childEntry) => {
        const previous = process.env.PARENT_PARSER_SECRET
        process.env.PARENT_PARSER_SECRET = 'must-not-cross-boundary'
        try {
          const parser = createKnowledgeParserProcess({ childEntry, timeoutMs: 2_000 })
          const result = await parser.parse({
            bytes: Buffer.from('sandbox probe'),
            mimeType: 'text/plain', versionId: 'sandbox_probe',
          })
          expect(result).toEqual({
            scrubbedEnv: true,
            fileDenied: true,
            procDenied: true,
            childProcessDenied: true,
            parentSignalDenied: true,
            nativeAddonDenied: true,
            netDenied: true,
            httpDenied: true,
            dnsDenied: true,
          })
          expect(tcpConnections).toBe(0)
          expect(udpPackets).toBe(0)
        } finally {
          if (previous === undefined) delete process.env.PARENT_PARSER_SECRET
          else process.env.PARENT_PARSER_SECRET = previous
        }
      })
    } finally {
      await Promise.all([
        new Promise<void>(resolve => tcp.close(() => resolve())),
        new Promise<void>(resolve => udp.close(() => resolve())),
      ])
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('kills a child whose external-memory RSS crosses the parent-owned ceiling', async () => {
    await withParserChild(`
      process.stdin.resume()
      process.stdin.on('end', () => {
        const external = Buffer.alloc(256 * 1024 * 1024, 1)
        const until = Date.now() + 1_000
        while (Date.now() < until) external[0] = (external[0] + 1) & 255
        const body = Buffer.from(JSON.stringify({ ok: true, result: { escaped: true } }))
        const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length)
        process.stdout.write(Buffer.concat([prefix, body]))
      })
    `, async (childEntry) => {
      const parser = createKnowledgeParserProcess({ childEntry, timeoutMs: 3_000 })
      await expect(parser.parse({
        bytes: Buffer.from('memory probe'), mimeType: 'text/plain', versionId: 'memory_probe',
      })).rejects.toEqual({ code: 'PARSER_LIMIT_EXCEEDED' })
    })
  })

  it('rejects an oversized input before spawning and zeroes its source bytes', async () => {
    const spawnImpl = vi.fn()
    const parser = createKnowledgeParserProcess({ maximumInputBytes: 4, spawnImpl })
    const bytes = Buffer.from('12345')

    await expect(parser.parse({ bytes, mimeType: 'text/plain', versionId: 'version_1' }))
      .rejects.toEqual({ code: 'PARSER_LIMIT_EXCEEDED' })
    expect(spawnImpl).not.toHaveBeenCalled()
    expect(bytes.every(byte => byte === 0)).toBe(true)
  })

  it('kills and closes a parser child when its request is cancelled', async () => {
    await withParserChild(`
      process.stdin.resume()
      process.stdin.on('end', () => setTimeout(() => undefined, 10_000))
    `, async (childEntry) => {
      let kill: ReturnType<typeof vi.spyOn> | undefined
      const parser = createKnowledgeParserProcess({
        childEntry, timeoutMs: 2_000,
        spawnImpl: (command, args, options) => {
          const child = spawn(command, args, options)
          kill = vi.spyOn(child, 'kill')
          return child
        },
      })
      const controller = new AbortController()
      const bytes = Buffer.from('cancel me')
      const parsing = parser.parse({
        bytes, mimeType: 'text/plain', versionId: 'version_cancel',
        signal: controller.signal,
      })
      const rejected = expect(parsing).rejects.toEqual({ code: 'TRANSIENT_FAILURE' })
      await vi.waitFor(() => expect(kill).toBeDefined())
      controller.abort()

      await rejected
      expect(kill).toHaveBeenCalledWith('SIGKILL')
      expect(bytes.every(byte => byte === 0)).toBe(true)
    })
  })

  it.each([
    ['crash', 'process.exit(7)', 'PARSER_FAILED'],
    ['malformed frame', 'process.stdout.write(Buffer.from([0, 0, 0, 2, 123, 125]))', 'PARSER_FAILED'],
    ['oversized frame', 'process.stdout.write(Buffer.alloc(256, 97))', 'PARSER_LIMIT_EXCEEDED'],
    ['duplicate frame', `
      const body = Buffer.from(JSON.stringify({ ok: false, error: { code: 'PARSER_FAILED' } }))
      const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length)
      process.stdout.write(Buffer.concat([prefix, body, prefix, body]))
    `, 'PARSER_FAILED'],
  ] as const)('fails closed for a parser child %s', async (_name, source, expectedCode) => {
    await withParserChild(source, async (childEntry) => {
      const parser = createKnowledgeParserProcess({
        childEntry, timeoutMs: 2_000, maximumResponseBytes: 128,
      })
      const bytes = Buffer.from('untrusted source')

      await expect(parser.parse({ bytes, mimeType: 'text/plain', versionId: 'version_1' }))
        .rejects.toEqual({ code: expectedCode })
      expect(bytes.every(byte => byte === 0)).toBe(true)
    })
  })

  it('cannot apply a late timed-out frame to a later parser request', async () => {
    await withParserChild(`
      const chunks = []
      process.stdin.on('data', chunk => chunks.push(chunk))
      process.stdin.on('end', () => {
        const input = Buffer.concat(chunks)
        const headerLength = input.readUInt32BE(0)
        const header = JSON.parse(input.subarray(4, 4 + headerLength).toString('utf8'))
        const result = {
          parserVersion: 'fixture-v1',
          blocks: [{ id: 'block_1', ordinal: 0, kind: 'paragraph', body: header.versionId,
            coordinates: { kind: 'txt', lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 1 } }],
          chunks: [{ id: 'chunk_1', blockId: 'block_1', ordinal: 0, body: header.versionId,
            coordinates: { kind: 'txt', lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 1 } }],
        }
        const body = Buffer.from(JSON.stringify({ ok: true, result }))
        const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length)
        setTimeout(() => process.stdout.write(Buffer.concat([prefix, body])),
          header.versionId === 'slow' ? 500 : 0)
      })
    `, async (childEntry) => {
      const parser = createKnowledgeParserProcess({ childEntry, timeoutMs: 250 })
      const slow = Buffer.from('slow')
      await expect(parser.parse({ bytes: slow, mimeType: 'text/plain', versionId: 'slow' }))
        .rejects.toEqual({ code: 'TRANSIENT_FAILURE' })
      const fast = Buffer.from('fast')
      const parsed = await parser.parse({
        bytes: fast, mimeType: 'text/plain', versionId: 'fast',
      })

      expect(parsed.blocks[0]?.body).toBe('fast')
      expect(slow.every(byte => byte === 0)).toBe(true)
      expect(fast.every(byte => byte === 0)).toBe(true)
    })
  })

  it('reads verified Storage bytes, parses, and commits index readiness atomically', async () => {
    const bytes = Buffer.from('云端合同条款')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const storage = {
      readObject: vi.fn().mockResolvedValue(bytes), deleteObjects: vi.fn(),
    }
    const parser = { parse: vi.fn().mockResolvedValue({
      parserVersion: 'cloud-parser-v1',
      blocks: [{ id: 'block_1', ordinal: 0, kind: 'paragraph', body: '云端合同条款',
        coordinates: { kind: 'txt', lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 6 } }],
      chunks: [{ id: 'chunk_1', blockId: 'block_1', ordinal: 0, body: '云端合同条款',
        coordinates: { kind: 'txt', lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 6 } }],
    }) }
    const rpc = vi.fn()
      .mockResolvedValueOnce(claim('job_upload', 'upload'))
      .mockResolvedValueOnce({
        ownerId: '1', knowledgeBaseId: 'kb_1', documentId: 'document_1',
        versionId: 'version_1', generationId: 'generation_1', objectId: 'object_1',
        storageReference: 'knowledge/1/kb_1/object_1', byteSize: bytes.byteLength,
        sha256, mimeType: 'text/plain', name: 'cloud.txt', versionNumber: 1,
      })
      .mockResolvedValueOnce({ completed: true, generationId: 'generation_1', embeddingJobId: null })
      .mockResolvedValueOnce({ job: null })
      .mockResolvedValueOnce({
        prunedChanges: 0, prunedTombstones: 0, prunedSnapshots: 0,
        prunedGenerations: 0, prunedDispatchPermits: 0,
      })
    const worker = createKnowledgeWorker({
      rpc, storage, parser, workerId: 'worker_1', id: () => 'lease_job_upload',
    })

    await expect(worker.runOnce()).resolves.toEqual({ claimed: 1, completed: 1, failed: 0 })
    expect(storage.readObject).toHaveBeenCalledWith({
      storageReference: 'knowledge/1/kb_1/object_1', byteSize: bytes.byteLength,
      sha256, mimeType: 'text/plain',
    })
    expect(rpc).toHaveBeenNthCalledWith(3, 'autoforge_knowledge_complete_upload_index',
      expect.objectContaining({
        p_worker_id: 'worker_1', p_job_id: 'job_upload',
        p_lease_token: 'lease_job_upload', p_generation_id: 'generation_1',
        p_blocks: expect.any(Array), p_chunks: expect.any(Array),
      }))
    expect(bytes.every(byte => byte === 0)).toBe(true)
  })

  it('deletes the exact Storage set before committing purge metadata', async () => {
    const order: string[] = []
    const rpc = vi.fn().mockImplementation(async (name: string) => {
      order.push(name)
      if (name === 'autoforge_knowledge_claim_job') {
        return order.filter(item => item === name).length === 1 ? claim('job_purge', 'purge') : { job: null }
      }
      if (name === 'autoforge_knowledge_prepare_base_purge') return {
        jobId: 'job_purge', storageReferences: ['knowledge/1/kb_1/a', 'knowledge/1/kb_1/b'],
      }
      if (name === 'autoforge_knowledge_complete_base_purge') return {
        jobId: 'job_purge', completed: true,
      }
      if (name === 'autoforge_knowledge_cleanup_retention') return {
        prunedChanges: 0, prunedTombstones: 0, prunedSnapshots: 0,
        prunedGenerations: 0, prunedDispatchPermits: 0,
      }
      throw new Error(`unexpected rpc ${name}`)
    })
    const storage = {
      readObject: vi.fn(),
      deleteObjects: vi.fn(async () => { order.push('storage.deleteObjects') }),
    }
    const worker = createKnowledgeWorker({
      rpc, storage, parser: { parse: vi.fn() }, workerId: 'worker_1',
      id: () => 'lease_job_purge',
    })

    await expect(worker.runOnce()).resolves.toMatchObject({ completed: 1 })
    expect(order.indexOf('storage.deleteObjects')).toBeGreaterThan(
      order.indexOf('autoforge_knowledge_prepare_base_purge'),
    )
    expect(order.indexOf('storage.deleteObjects')).toBeLessThan(
      order.indexOf('autoforge_knowledge_complete_base_purge'),
    )
  })

  it('wires embedding jobs and bounds every scheduled invocation to eight claims', async () => {
    let claims = 0
    const rpc = vi.fn().mockImplementation(async (name: string) => {
      if (name === 'autoforge_knowledge_claim_job') {
        claims += 1
        return claim(`job_embedding_${claims}`, 'embedding')
      }
      if (name === 'autoforge_knowledge_cleanup_retention') return {
        prunedChanges: 0, prunedTombstones: 0, prunedSnapshots: 0,
        prunedGenerations: 0, prunedDispatchPermits: 0,
      }
      throw new Error(`unexpected rpc ${name}`)
    })
    const embeddingWorker = { run: vi.fn().mockResolvedValue({ state: 'completed', embedded: 1 }) }
    const worker = createKnowledgeWorker({
      rpc, storage: { readObject: vi.fn(), deleteObjects: vi.fn() },
      parser: { parse: vi.fn() }, embeddingWorker, workerId: 'worker_1',
      id: () => `lease_job_embedding_${claims + 1}`,
    })

    await expect(worker.runOnce()).resolves.toEqual({ claimed: 8, completed: 8, failed: 0 })
    expect(claims).toBe(8)
    expect(embeddingWorker.run).toHaveBeenCalledTimes(8)
  })

  it('yields a bounded embedding slice without spending its transient retry budget', async () => {
    let claims = 0
    const rpc = vi.fn().mockImplementation(async (name: string) => {
      if (name === 'autoforge_knowledge_claim_job') {
        claims += 1
        return claims === 1 ? claim('job_embedding', 'embedding') : { job: null }
      }
      if (name === 'autoforge_knowledge_yield_job') return { yielded: true }
      if (name === 'autoforge_knowledge_cleanup_retention') return {
        prunedChanges: 0, prunedTombstones: 0, prunedSnapshots: 0,
        prunedGenerations: 0, prunedDispatchPermits: 0,
      }
      throw new Error(`unexpected rpc ${name}`)
    })
    const worker = createKnowledgeWorker({
      rpc, storage: { readObject: vi.fn(), deleteObjects: vi.fn() },
      parser: { parse: vi.fn() }, workerId: 'worker_1',
      embeddingWorker: { run: vi.fn().mockResolvedValue({ state: 'partial', embedded: 2 }) },
      id: () => 'lease_job_embedding',
    })

    await expect(worker.runOnce()).resolves.toEqual({ claimed: 1, completed: 1, failed: 0 })
    expect(rpc).toHaveBeenCalledWith('autoforge_knowledge_yield_job', {
      p_worker_id: 'worker_1', p_job_id: 'job_embedding',
      p_lease_token: 'lease_job_embedding',
    })
    expect(rpc.mock.calls.some(([name]) => name === 'autoforge_knowledge_complete_job')).toBe(false)
    expect(rpc.mock.calls.filter(([name]) => name === 'autoforge_knowledge_claim_job')).toHaveLength(1)
  })

  it('settles transient and terminal failures with the claimed lease identity', async () => {
    for (const [failure, expectedCode] of [
      [{ code: 'TRANSIENT_FAILURE' }, 'TRANSIENT_FAILURE'],
      [new Error('private parser detail'), 'INTERNAL_ERROR'],
    ] as const) {
      let claims = 0
      const rpc = vi.fn().mockImplementation(async (name: string) => {
        if (name === 'autoforge_knowledge_claim_job') {
          claims += 1
          return claims === 1 ? claim('job_upload', 'upload', 3) : { job: null }
        }
        if (name === 'autoforge_knowledge_get_upload_work') throw failure
        if (name === 'autoforge_knowledge_complete_job') return { completed: true }
        if (name === 'autoforge_knowledge_cleanup_retention') return {
          prunedChanges: 0, prunedTombstones: 0, prunedSnapshots: 0,
          prunedGenerations: 0, prunedDispatchPermits: 0,
        }
        throw new Error(`unexpected rpc ${name}`)
      })
      const worker = createKnowledgeWorker({
        rpc, storage: { readObject: vi.fn(), deleteObjects: vi.fn() },
        parser: { parse: vi.fn() }, workerId: 'worker_1', id: () => 'lease_job_upload',
      })

      await expect(worker.runOnce()).resolves.toEqual({ claimed: 1, completed: 0, failed: 1 })
      expect(rpc).toHaveBeenCalledWith('autoforge_knowledge_complete_job', {
        p_worker_id: 'worker_1', p_job_id: 'job_upload',
        p_lease_token: 'lease_job_upload', p_state: 'failed', p_error_code: expectedCode,
      })
      if (expectedCode === 'TRANSIENT_FAILURE') {
        expect(rpc.mock.calls.filter(([name]) => (
          name === 'autoforge_knowledge_claim_job'
        ))).toHaveLength(1)
      }
    }
  })

  it('settles a never-resolving parser before its lease expires and returns from runOnce', async () => {
    vi.useFakeTimers()
    try {
      const bytes = Buffer.from('bounded parser source')
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      let claims = 0
      const rpc = vi.fn().mockImplementation(async (name: string) => {
        if (name === 'autoforge_knowledge_claim_job') {
          claims += 1
          return claims === 1 ? claim('job_upload', 'upload') : { job: null }
        }
        if (name === 'autoforge_knowledge_get_upload_work') return {
          ownerId: '1', knowledgeBaseId: 'kb_1', documentId: 'document_1',
          versionId: 'version_1', generationId: 'generation_1', objectId: 'object_1',
          storageReference: 'knowledge/1/kb_1/object_1', byteSize: bytes.byteLength,
          sha256, mimeType: 'text/plain', name: 'cloud.txt', versionNumber: 1,
        }
        if (name === 'autoforge_knowledge_complete_job') return { completed: true }
        if (name === 'autoforge_knowledge_cleanup_retention') return {
          prunedChanges: 0, prunedTombstones: 0, prunedSnapshots: 0,
          prunedGenerations: 0, prunedDispatchPermits: 0,
        }
        throw new Error(`unexpected rpc ${name}`)
      })
      let parserSignal: AbortSignal | undefined
      const worker = createKnowledgeWorker({
        rpc,
        storage: { readObject: vi.fn().mockResolvedValue(bytes), deleteObjects: vi.fn() },
        parser: { parse: vi.fn(({ signal }: { signal?: AbortSignal }) => {
          parserSignal = signal
          return new Promise<never>(() => undefined)
        }) },
        parserTimeoutMs: 50,
        workerId: 'worker_1', id: () => 'lease_job_upload',
      })

      const run = worker.runOnce()
      const bounded = Promise.race([
        run,
        new Promise<'unsettled'>(resolve => setTimeout(() => resolve('unsettled'), 60)),
      ])
      await vi.advanceTimersByTimeAsync(60)

      await expect(bounded).resolves.toEqual({ claimed: 1, completed: 0, failed: 1 })
      expect(parserSignal?.aborted).toBe(true)
      expect(bytes.every(byte => byte === 0)).toBe(true)
      expect(rpc).toHaveBeenCalledWith('autoforge_knowledge_complete_job', {
        p_worker_id: 'worker_1', p_job_id: 'job_upload',
        p_lease_token: 'lease_job_upload', p_state: 'failed',
        p_error_code: 'TRANSIENT_FAILURE',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['upload-work RPC', 'rpc'],
    ['Storage read', 'storage'],
    ['upload completion RPC', 'post-rpc'],
  ] as const)('shares a 120-second claim deadline with a never-settling %s', async (_name, stalled) => {
    vi.useFakeTimers()
    try {
      const bytes = Buffer.from('claim deadline source')
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      let claims = 0
      const rpc = vi.fn().mockImplementation(async (name: string) => {
        if (name === 'autoforge_knowledge_claim_job') {
          claims += 1
          return claims === 1 ? claim('job_upload', 'upload') : { job: null }
        }
        if (name === 'autoforge_knowledge_get_upload_work') {
          if (stalled === 'rpc') return new Promise<never>(() => undefined)
          return {
            ownerId: '1', knowledgeBaseId: 'kb_1', documentId: 'document_1',
            versionId: 'version_1', generationId: 'generation_1', objectId: 'object_1',
            storageReference: 'knowledge/1/kb_1/object_1', byteSize: bytes.byteLength,
            sha256, mimeType: 'text/plain', name: 'cloud.txt', versionNumber: 1,
          }
        }
        if (name === 'autoforge_knowledge_complete_upload_index') {
          if (stalled === 'post-rpc') return new Promise<never>(() => undefined)
          return { completed: true, generationId: 'generation_1', embeddingJobId: null }
        }
        if (name === 'autoforge_knowledge_complete_job') return { completed: true }
        if (name === 'autoforge_knowledge_cleanup_retention') return {
          prunedChanges: 0, prunedTombstones: 0, prunedSnapshots: 0,
          prunedGenerations: 0, prunedDispatchPermits: 0,
        }
        throw new Error(`unexpected rpc ${name}`)
      })
      const worker = createKnowledgeWorker({
        rpc,
        storage: {
          readObject: stalled === 'storage'
            ? vi.fn(() => new Promise<never>(() => undefined))
            : vi.fn().mockResolvedValue(bytes),
          deleteObjects: vi.fn(),
        },
        parser: { parse: vi.fn().mockResolvedValue({
          parserVersion: 'cloud-parser-v1',
          blocks: [{ id: 'block_1', ordinal: 0, kind: 'paragraph', body: 'claim deadline source',
            coordinates: { kind: 'txt', lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 21 } }],
          chunks: [{ id: 'chunk_1', blockId: 'block_1', ordinal: 0, body: 'claim deadline source',
            coordinates: { kind: 'txt', lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 21 } }],
        }) }, workerId: 'worker_1',
        id: () => 'lease_job_upload', parserTimeoutMs: 120_000,
      })

      const outcome = Promise.race([
        worker.runOnce().then(result => ({ kind: 'settled' as const, result })),
        new Promise<{ kind: 'unsettled' }>(resolve => {
          setTimeout(() => resolve({ kind: 'unsettled' }), 120_001)
        }),
      ])
      await vi.advanceTimersByTimeAsync(120_001)

      await expect(outcome).resolves.toEqual({
        kind: 'settled', result: { claimed: 1, completed: 0, failed: 1 },
      })
      expect(rpc).toHaveBeenCalledWith('autoforge_knowledge_complete_job', {
        p_worker_id: 'worker_1', p_job_id: 'job_upload',
        p_lease_token: 'lease_job_upload', p_state: 'failed',
        p_error_code: 'TRANSIENT_FAILURE',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a parser timeout configuration beyond the 120-second claim budget', () => {
    expect(() => createKnowledgeWorker({
      rpc: vi.fn(), storage: { readObject: vi.fn(), deleteObjects: vi.fn() },
      parser: { parse: vi.fn() }, workerId: 'worker_1', parserTimeoutMs: 120_001,
    })).toThrow('Knowledge worker is not configured')
  })

  it('parses bounded text into stable worker blocks and chunks', async () => {
    const parser = createKnowledgeParser()
    const input = {
      bytes: Buffer.from('第一条\n\n第二条'), mimeType: 'text/plain', versionId: 'version_1',
    }
    const first = await parser.parse(input)
    const second = await parser.parse(input)
    expect(first).toEqual(second)
    expect(first.parserVersion).toBe('autoforge-cloud-parser-v1')
    expect(first.blocks.map(({ ordinal, body }) => ({ ordinal, body }))).toEqual([
      { ordinal: 0, body: '第一条' }, { ordinal: 1, body: '第二条' },
    ])
    expect(first.chunks.map(({ ordinal, body }) => ({ ordinal, body }))).toEqual([
      { ordinal: 0, body: '第一条' }, { ordinal: 1, body: '第二条' },
    ])
  })

  it.each([
    ['expanded-byte ceiling', 1024, (32 * 1024 * 1024) + 1],
    ['compression-ratio ceiling', 1, 101],
  ] as const)('rejects a DOCX %s before invoking Mammoth', async (_name, compressed, expanded) => {
    const extractRawText = vi.fn()
    const parser = createKnowledgeParser({
      loadMammoth: () => ({ extractRawText }),
    })

    await expect(parser.parse({
      bytes: docxDirectoryFixture(compressed, expanded),
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      versionId: 'version_docx',
    })).rejects.toEqual({ code: 'PARSER_LIMIT_EXCEEDED' })
    expect(extractRawText).not.toHaveBeenCalled()
  })

  it('checks actual DOCX expansion before invoking Mammoth', async () => {
    const extractRawText = vi.fn()
    const parser = createKnowledgeParser({ loadMammoth: () => ({ extractRawText }) })

    await expect(parser.parse({
      bytes: docxArchiveFixture(Buffer.from('a'.repeat(1_024)), 16),
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      versionId: 'version_docx',
    })).rejects.toEqual({ code: 'PARSER_LIMIT_EXCEEDED' })
    expect(extractRawText).not.toHaveBeenCalled()
  })

  it('rejects DOCX entity declarations before invoking Mammoth', async () => {
    const extractRawText = vi.fn().mockResolvedValue({ value: 'must not parse' })
    const parser = createKnowledgeParser({ loadMammoth: () => ({ extractRawText }) })

    await expect(parser.parse({
      bytes: docxArchiveFixture(Buffer.from(
        '<!DOCTYPE w:document [<!ENTITY secret SYSTEM "file:///etc/passwd">]><w:document>&secret;</w:document>',
      )),
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      versionId: 'version_docx_entity',
    })).rejects.toEqual({ code: 'PARSER_FAILED' })
    expect(extractRawText).not.toHaveBeenCalled()
  })

  it('rejects entity declarations in DOCX relationship XML before invoking Mammoth', async () => {
    const extractRawText = vi.fn().mockResolvedValue({ value: 'must not parse' })
    const parser = createKnowledgeParser({ loadMammoth: () => ({ extractRawText }) })

    await expect(parser.parse({
      bytes: docxArchiveFixture(Buffer.from(
        '<!DOCTYPE Relationships [<!ENTITY secret SYSTEM "file:///etc/passwd">]><Relationships>&secret;</Relationships>',
      ), undefined, '_rels/.rels'),
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      versionId: 'version_docx_relationship_entity',
    })).rejects.toEqual({ code: 'PARSER_FAILED' })
    expect(extractRawText).not.toHaveBeenCalled()
  })

  it('disables Mammoth external file access after bounded DOCX preflight', async () => {
    const extractRawText = vi.fn().mockResolvedValue({ value: 'bounded text' })
    const parser = createKnowledgeParser({ loadMammoth: () => ({ extractRawText }) })
    const bytes = docxArchiveFixture(Buffer.from('<w:document><w:p><w:r><w:t>bounded text</w:t></w:r></w:p></w:document>'))

    await expect(parser.parse({
      bytes,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      versionId: 'version_docx_bounded',
    })).resolves.toMatchObject({ blocks: [expect.objectContaining({ body: 'bounded text' })] })
    expect(extractRawText).toHaveBeenCalledWith(
      { buffer: bytes },
      { externalFileAccess: false },
    )
  })

  it('rejects an excessive PDF page count before loading the first page', async () => {
    const document = {
      numPages: 1001,
      getPage: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
    }
    const parser = createKnowledgeParser({
      loadPdfjs: () => ({
        getDocument: () => ({ promise: Promise.resolve(document) }),
      }),
    })

    await expect(parser.parse({
      bytes: Buffer.from('%PDF fixture'), mimeType: 'application/pdf', versionId: 'version_pdf',
    })).rejects.toEqual({ code: 'PARSER_LIMIT_EXCEEDED' })
    expect(document.getPage).not.toHaveBeenCalled()
    expect(document.destroy).toHaveBeenCalledOnce()
  })

  it('stops PDF text accumulation at its byte ceiling before reading another page', async () => {
    const body = 'a'.repeat(8 * 1024 * 1024)
    const cancellations: Array<ReturnType<typeof vi.fn>> = []
    const cleanups: Array<ReturnType<typeof vi.fn>> = []
    const getPage = vi.fn().mockImplementation(async () => ({
      streamTextContent: () => {
        const cancel = vi.fn().mockResolvedValue(undefined)
        cancellations.push(cancel)
        let read = false
        return { getReader: () => ({
          read: vi.fn(async () => read
            ? { done: true, value: undefined }
            : (read = true, { done: false, value: { items: [{ str: body }] } })),
          cancel,
          releaseLock: vi.fn(),
        }) }
      },
      cleanup: (() => { const cleanup = vi.fn(); cleanups.push(cleanup); return cleanup })(),
    }))
    const document = {
      numPages: 3,
      getPage,
      destroy: vi.fn().mockResolvedValue(undefined),
    }
    const parser = createKnowledgeParser({
      loadPdfjs: () => ({
        getDocument: () => ({ promise: Promise.resolve(document) }),
      }),
    })

    await expect(parser.parse({
      bytes: Buffer.from('%PDF fixture'), mimeType: 'application/pdf', versionId: 'version_pdf',
    })).rejects.toEqual({ code: 'PARSER_LIMIT_EXCEEDED' })
    expect(getPage).toHaveBeenCalledTimes(2)
    expect(cancellations[1]).toHaveBeenCalledOnce()
    expect(cleanups.every(cleanup => cleanup.mock.calls.length === 1)).toBe(true)
    expect(document.destroy).toHaveBeenCalledOnce()
  })

  it('cleans up a loaded PDF page when its text stream is malformed', async () => {
    const cleanup = vi.fn()
    const document = {
      numPages: 1,
      getPage: vi.fn().mockResolvedValue({
        streamTextContent: () => ({ malformed: true }), cleanup,
      }),
      destroy: vi.fn().mockResolvedValue(undefined),
    }
    const parser = createKnowledgeParser({
      loadPdfjs: () => ({ getDocument: () => ({ promise: Promise.resolve(document) }) }),
    })

    await expect(parser.parse({
      bytes: Buffer.from('%PDF malformed stream'),
      mimeType: 'application/pdf', versionId: 'version_pdf_malformed_stream',
    })).rejects.toEqual({ code: 'PARSER_FAILED' })
    expect(cleanup).toHaveBeenCalledOnce()
    expect(document.destroy).toHaveBeenCalledOnce()
  })

  it('uses streamed PDF text with all active-content and external-resource features disabled', async () => {
    const getDocument = vi.fn(() => ({ promise: Promise.resolve({
      numPages: 1,
      getPage: vi.fn(async () => ({
        streamTextContent: () => ({ getReader: () => {
          let read = false
          return {
            read: vi.fn(async () => read
              ? { done: true, value: undefined }
              : (read = true, { done: false, value: { items: [{ str: 'safe PDF text' }] } })),
            cancel: vi.fn(), releaseLock: vi.fn(),
          }
        } }),
        cleanup: vi.fn(),
      })),
      destroy: vi.fn().mockResolvedValue(undefined),
    }) }))
    const parser = createKnowledgeParser({ loadPdfjs: () => ({ getDocument }) })

    await expect(parser.parse({
      bytes: Buffer.from('%PDF malicious fixture'),
      mimeType: 'application/pdf', versionId: 'version_pdf_safe',
    })).resolves.toMatchObject({ blocks: [expect.objectContaining({ body: 'safe PDF text' })] })
    expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({
      maxDecodedStreamBytes: 64 * 1024 * 1024,
      stopAtErrors: true,
      maxImageSize: 0,
      canvasMaxAreaInBytes: 0,
      isEvalSupported: false,
      disableFontFace: true,
      enableXfa: false,
      useWasm: false,
      useWorkerFetch: false,
      disableAutoFetch: true,
      disableStream: true,
      disableRange: true,
    }))
    expect(getDocument.mock.calls[0]?.[0]).not.toHaveProperty('url')
    expect(getDocument.mock.calls[0]?.[0]).not.toHaveProperty('cMapUrl')
    expect(getDocument.mock.calls[0]?.[0]).not.toHaveProperty('standardFontDataUrl')
    expect(getDocument.mock.calls[0]?.[0]).not.toHaveProperty('wasmUrl')
  })

  it('rejects an actual one-page decoded-stream bomb under the patched PDF.js budget', async () => {
    const parser = createKnowledgeParser()
    const bytes = pdfFixture('must not escape', 64 * 1024 * 1024)
    expect(bytes.byteLength).toBeLessThan(128 * 1024)

    await expect(parser.parse({
      bytes, mimeType: 'application/pdf', versionId: 'version_pdf_bomb',
    })).rejects.toEqual({ code: 'PARSER_LIMIT_EXCEEDED' })
  })

  it('bounds text blocks and serialized parser response while accumulating', async () => {
    const parser = createKnowledgeParser()
    const tooManyBlocks = Buffer.from(Array.from(
      { length: 10_001 }, (_, index) => `paragraph ${index}`,
    ).join('\n\n'))
    await expect(parser.parse({
      bytes: tooManyBlocks, mimeType: 'text/plain', versionId: 'version_blocks',
    })).rejects.toEqual({ code: 'PARSER_LIMIT_EXCEEDED' })
    await expect(parser.parse({
      bytes: Buffer.from('x'.repeat(800_000)),
      mimeType: 'text/plain', versionId: 'version_response',
    })).rejects.toEqual({ code: 'PARSER_LIMIT_EXCEEDED' })
  })

  it('aborts a never-settling private Storage read at its deadline', async () => {
    vi.useFakeTimers()
    try {
      let signal: AbortSignal | undefined
      const storage = createWorkerStorageClient({
        baseUrl: 'https://pg-storage.example/v1/storage', serviceKey: 'server-only',
        timeoutMs: 50,
        fetchImpl: vi.fn((_url: string, init: { signal: AbortSignal }) => {
          signal = init.signal
          return new Promise<never>(() => undefined)
        }),
      })
      const read = storage.readObject({
        storageReference: 'knowledge/1/kb_1/object_1', byteSize: 4,
        sha256: 'a'.repeat(64), mimeType: 'text/plain',
      })
      const rejected = expect(read).rejects.toEqual({ code: 'TRANSIENT_FAILURE' })
      await vi.advanceTimersByTimeAsync(50)
      await rejected
      expect(signal?.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
