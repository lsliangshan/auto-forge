import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { createServer as createHttpsServer } from 'node:https'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants, deflateRawSync, deflateSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { createKnowledgeParserProcess } from '../../cloudbase/knowledge/worker/parser-process.js'
import {
  createKnowledgeParser,
  createKnowledgeWorker,
  createWorkerStorageClient,
} from '../../cloudbase/knowledge/worker/knowledge-worker.js'

const claim = (id: string, kind: 'upload' | 'embedding' | 'purge', attempt = 1) => ({
  job: {
    id, kind, entityId: `${kind}_entity`, leaseToken: `lease_${id}`, attempt,
    mutationPermit: `permit_${id}`, mutationBudgetMs: 120_000,
  },
})

const requestBoundary = () => expect.objectContaining({
  signal: expect.any(AbortSignal),
  timeoutMs: expect.any(Number),
  remainingMs: expect.any(Function),
  mutationAuthorization: expect.objectContaining({
    capability: expect.any(String), workerId: expect.any(String),
    jobId: expect.any(String), leaseToken: expect.any(String),
  }),
})

type Boundary = {
  signal: AbortSignal
  timeoutMs: number
  remainingMs: () => number
  mutationAuthorization: {
    capability: string; workerId: string; jobId: string; leaseToken: string
  }
}

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

async function withAsyncEaccesExecutable<T>(run: (path: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'autoforge-spawn-eacces-'))
  const path = join(directory, 'node')
  await writeFile(path, '', { encoding: 'utf8', mode: 0o600 })
  try {
    const child = spawn(path, [], { stdio: 'ignore', windowsHide: true })
    const error = new Promise<NodeJS.ErrnoException>((resolvePromise, rejectPromise) => {
      child.once('error', resolvePromise)
      child.once('spawn', () => rejectPromise(new Error('Denied executable unexpectedly spawned')))
    })
    const closed = new Promise<void>(resolvePromise => child.once('close', () => resolvePromise()))
    expect(child.pid).toBeUndefined()
    await expect(error).resolves.toMatchObject({ code: 'EACCES' })
    await closed
    return await run(path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

type ProcessRow = {
  pid: number; parentPid: number; groupId: number; state: string; command: string
}

async function processRows(): Promise<ProcessRow[]> {
  const child = spawn('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,state=,command=', '-ww'], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const code = await new Promise<number | null>((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise)
    child.once('close', resolvePromise)
  })
  if (code !== 0 || stderr !== '') throw new Error(`ps failed: ${stderr}`)
  return stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/u.exec(line)
    if (!match) return []
    return [{
      pid: Number(match[1]), parentPid: Number(match[2]), groupId: Number(match[3]),
      state: match[4] ?? '', command: match[5] ?? '',
    }]
  })
}

function descendantRows(rows: ProcessRow[], rootPid: number): ProcessRow[] {
  const descendants = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (descendants.has(row.parentPid) && !descendants.has(row.pid)) {
        descendants.add(row.pid)
        changed = true
      }
    }
  }
  descendants.delete(rootPid)
  return rows.filter(row => descendants.has(row.pid))
}

async function waitForDescendant(
  rootPid: number, predicate: (row: ProcessRow) => boolean, timeoutMs = 5_000,
): Promise<ProcessRow> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = descendantRows(await processRows(), rootPid).find(predicate)
    if (found) return found
    await delay(10)
  }
  throw new Error('Expected descendant process did not start')
}

async function waitForStoppedProcess(pid: number, timeoutMs = 2_000): Promise<ProcessRow> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const row = (await processRows()).find(candidate => candidate.pid === pid)
    if (!row) throw new Error('Expected process disappeared before stopping')
    if (row.state.includes('T')) return row
    await delay(10)
  }
  throw new Error('Expected process did not enter the stopped state')
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function startProductionScheduler(
  baseUrl: string,
  certificateUrl: URL,
  deniedSpawn?: { executablePath: string; moduleName: string },
) {
  const entry = fileURLToPath(new URL(
    '../../cloudbase/knowledge/index.js', import.meta.url,
  ))
  const denySpawn = deniedSpawn ? `
    const realExecPath = process.execPath
    let matchingExecPathReads = 0
    Object.defineProperty(process, 'execPath', { configurable: true, get() {
      const stack = new Error().stack ?? ''
      if (stack.includes(${JSON.stringify(deniedSpawn.moduleName)})) {
        matchingExecPathReads += 1
        if (matchingExecPathReads === 2) return ${JSON.stringify(deniedSpawn.executablePath)}
      }
      return realExecPath
    } })
  ` : ''
  const runner = `${denySpawn}const { main } = require(${JSON.stringify(entry)}); main().then(`
    + `result => process.stdout.write(JSON.stringify({ ok: true, pid: process.pid, result }) + '\\n'), `
    + `error => process.stdout.write(JSON.stringify({ ok: false, pid: process.pid, code: error?.code }) + '\\n'))`
  const child = spawn(process.execPath, ['--no-addons', '-e', runner], {
    env: {
      AUTOFORGE_PG_RPC_BASE_URL: baseUrl,
      AUTOFORGE_PG_STORAGE_BASE_URL: baseUrl,
      AUTOFORGE_PG_SERVICE_KEY: 'test-service-key',
      AUTOFORGE_KNOWLEDGE_MUTATION_PERMIT_PORT_VERSION: 'db-job-v1',
      AUTOFORGE_KNOWLEDGE_WORKER_ID: 'worker_1',
      NODE_EXTRA_CA_CERTS: fileURLToPath(certificateUrl),
    },
    stdio: ['ignore', 'pipe', 'pipe'], detached: deniedSpawn !== undefined, windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const output = new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
    const inspect = () => {
      const newline = stdout.indexOf('\n')
      if (newline < 0) return
      try { resolvePromise(JSON.parse(stdout.slice(0, newline))) } catch (error) {
        rejectPromise(error)
      }
    }
    child.stdout.on('data', inspect)
    child.once('error', rejectPromise)
    child.once('close', (code, signal) => {
      inspect()
      if (!stdout.includes('\n')) {
        rejectPromise(new Error(`scheduler closed before result: ${code}/${signal}: ${stderr}`))
      }
    })
  })
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolvePromise, rejectPromise) => {
      child.once('error', rejectPromise)
      child.once('close', (code, signal) => resolvePromise({ code, signal }))
    },
  )
  return { child, output, closed, stderr: () => stderr }
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

function pdfFilteredFixture(filter: string, stream: Buffer): Buffer {
  const objects = [
    Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', 'ascii'),
    Buffer.from('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n', 'ascii'),
    Buffer.from('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n', 'ascii'),
    Buffer.from('4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n', 'ascii'),
    Buffer.concat([
      Buffer.from(`5 0 obj\n<< /Length ${stream.byteLength} /Filter /${filter} >>\nstream\n`, 'ascii'),
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

function pdfFixture(text: string, expandedPaddingBytes = 0): Buffer {
  const content = Buffer.concat([
    Buffer.alloc(expandedPaddingBytes, 0x20),
    Buffer.from(`BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/gu, '\\$&')}) Tj ET`, 'ascii'),
  ])
  const stream = deflateSync(content)
  content.fill(0)
  const fixture = pdfFilteredFixture('FlateDecode', stream)
  stream.fill(0)
  return fixture
}

describe('CloudBase knowledge scheduled worker', () => {
  it('ships a directly deployable CommonJS scheduled entry', async () => {
    const [rootEntry, entry, jobEntry, jobProcess, childEntry, parserProcess,
      settlementEntry, settlementProcess, packageJson, childPackageJson, deployLock]
      = await Promise.all([
      readFile(new URL('../../cloudbase/knowledge/index.js', import.meta.url), 'utf8'),
      readFile(new URL('../../cloudbase/knowledge/worker/index.js', import.meta.url), 'utf8'),
      readFile(new URL('../../cloudbase/knowledge/worker/job-child.js', import.meta.url), 'utf8'),
      readFile(new URL('../../cloudbase/knowledge/worker/job-process.js', import.meta.url), 'utf8'),
      readFile(new URL('../../cloudbase/knowledge/worker/parser-child.js', import.meta.url), 'utf8'),
      readFile(new URL('../../cloudbase/knowledge/worker/parser-process.js', import.meta.url), 'utf8'),
      readFile(new URL('../../cloudbase/knowledge/worker/settlement-child.js', import.meta.url), 'utf8'),
      readFile(new URL('../../cloudbase/knowledge/worker/settlement-process.js', import.meta.url), 'utf8'),
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
    expect(entry).toContain('createKnowledgeJobProcess')
    expect(entry).toContain('createKnowledgeParserProcess')
    expect(entry).toContain('createKnowledgeSettlementProcess')
    expect(entry).not.toContain('createKnowledgeParser()')
    expect(jobEntry).toContain('createEmbeddingGenerationWorker')
    expect(jobEntry).toContain('maximumChunksPerRun: 2')
    expect(jobEntry).toContain('createKnowledgeParserProcess')
    expect(jobProcess).toContain('detached: true')
    expect(jobProcess).toContain('process.kill(-groupId')
    expect(childEntry).not.toMatch(/knowledge-handler|TOKENHUB|PG_SERVICE|STORAGE_BASE|RPC_BASE/u)
    expect(parserProcess).not.toMatch(/knowledge-handler|TOKENHUB|PG_SERVICE|STORAGE_BASE|RPC_BASE/u)
    expect(settlementEntry).not.toMatch(/TOKENHUB|STORAGE_BASE/u)
    expect(settlementProcess).toContain('detached: true')
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
        '--jitless',
        '--permission',
        '--no-addons',
        '--max-old-space-size=128',
        expect.stringMatching(/parser-child\.js$/u),
      ]))
      expect(launches[0]?.options).toMatchObject({
        env: { AUTOFORGE_PARSER_CHILD: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const profile = launches[0]?.args[1]
      expect(profile).toContain('(deny dynamic-code-generation)')
      expect(profile).toContain('(literal "/usr/lib/libSystem.B.dylib")')
      expect(profile).not.toMatch(/\(subpath "\/(?:System|usr\/lib|usr\/share)"\)/u)
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
        try { process.dlopen({ exports: {} }, ${JSON.stringify(secretPath)}); results.nativeAddonDenied = false }
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

  it('denies real system SQLite and dylib access at the Seatbelt syscall boundary', async () => {
    const databasePath = '/System/Library/Security/Certificates.bundle/Contents/Resources/valid.sqlite3'
    const extensionBasePath = '/System/Library/Perl/5.34/darwin-thread-multi-2level/CORE/libperl'
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(databasePath, { readOnly: true })
    expect(database.prepare('SELECT count(*) AS count FROM sqlite_master').get()).toMatchObject({
      count: expect.any(Number),
    })
    database.close()
    const extensionProbe = new DatabaseSync(':memory:', { allowExtension: true })
    extensionProbe.enableLoadExtension(true)
    expect(() => extensionProbe.loadExtension(extensionBasePath)).toThrow(/symbol not found/iu)
    extensionProbe.close()
    await withParserChild(`
        const { DatabaseSync } = require('node:sqlite')
        const denied = error => ['ERR_ACCESS_DENIED', 'EPERM', 'EACCES'].includes(error?.code)
          || /(?:operation not permitted|permission denied|access denied)/iu.test(String(error?.message))
        const results = { nodePermissionDisabled: process.permission === undefined }
        try {
          const database = new DatabaseSync(${JSON.stringify(databasePath)}, { readOnly: true })
          database.prepare('SELECT count(*) AS count FROM sqlite_master').get()
          database.close()
          results.systemDatabaseReadDenied = false
        } catch (error) {
          results.systemDatabaseReadDenied = denied(error)
            || error?.code === 'ERR_SQLITE_ERROR' && error?.message === 'unable to open database file'
        }
        try {
          const database = new DatabaseSync(':memory:', { allowExtension: true })
          database.enableLoadExtension(true)
          database.loadExtension(${JSON.stringify(extensionBasePath)})
          database.close()
          results.systemLibraryOpenDenied = false
        } catch (error) {
          results.systemLibraryOpenDenied = denied(error)
            || error?.code === 'ERR_LOAD_SQLITE_EXTENSION'
              && /(?:file system sandbox blocked open|blocked by sandbox)/iu.test(error?.message)
        }
        const body = Buffer.from(JSON.stringify({ ok: true, result: results }))
        const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length)
        process.stdout.write(Buffer.concat([prefix, body]))
      `, async (childEntry) => {
        const parser = createKnowledgeParserProcess({
          childEntry, timeoutMs: 2_000,
          spawnImpl: (command, args, options) => spawn(command, args.filter(argument => (
            argument !== '--permission' && argument !== '--no-addons'
              && !argument.startsWith('--allow-fs-read=')
          )), options),
        })
        await expect(parser.parse({
          bytes: Buffer.from('sqlite probe'), mimeType: 'text/plain', versionId: 'sqlite_probe',
        })).resolves.toEqual({
          nodePermissionDisabled: true,
          systemDatabaseReadDenied: true,
          systemLibraryOpenDenied: true,
        })
      })
  })

  it('denies executable mapping for a real native addon inside the parser dependency tree', async () => {
    const addonPath = await realpath(new URL([
      '../../cloudbase/knowledge/node_modules/.pnpm/',
      '@napi-rs+canvas-darwin-arm64@1.0.8/node_modules/',
      '@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node',
    ].join(''), import.meta.url))
    await withParserChild(`
      const denied = error => ['ERR_ACCESS_DENIED', 'EPERM', 'EACCES'].includes(error?.code)
        || /(?:operation not permitted|permission denied|access denied|sandbox)/iu
          .test(String(error?.message))
      let nativeDependencyMapDenied
      try {
        require(${JSON.stringify(addonPath)})
        nativeDependencyMapDenied = false
      } catch (error) {
        nativeDependencyMapDenied = denied(error)
      }
      const body = Buffer.from(JSON.stringify({ ok: true, result: {
        nodePermissionDisabled: process.permission === undefined,
        nativeDependencyMapDenied,
      } }))
      const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length)
      process.stdout.write(Buffer.concat([prefix, body]))
    `, async (childEntry) => {
      let profile = ''
      const parser = createKnowledgeParserProcess({
        childEntry, timeoutMs: 2_000,
        spawnImpl: (command, args, options) => {
          profile = args[1] ?? ''
          return spawn(command, args.filter(argument => (
            argument !== '--permission' && argument !== '--no-addons'
              && !argument.startsWith('--allow-fs-read=')
          )), options)
        },
      })
      await expect(parser.parse({
        bytes: Buffer.from('native dependency probe'),
        mimeType: 'text/plain', versionId: 'native_dependency_probe',
      })).resolves.toEqual({
        nodePermissionDisabled: true,
        nativeDependencyMapDenied: true,
      })
      expect(profile).toMatch(/\(deny file-map-executable\s+\(subpath "[^"]+\/node_modules"\)\)/u)
    })
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

  it('keeps the production scheduler alive after forcibly terminating one job process', async () => {
    const certificateUrl = new URL(
      '../../apps/desktop/electron/main/media/test-fixtures/pinned-media-test-cert.pem',
      import.meta.url,
    )
    const keyUrl = new URL(
      '../../apps/desktop/electron/main/media/test-fixtures/pinned-media-test-key.pem',
      import.meta.url,
    )
    const [certificate, key] = await Promise.all([
      readFile(certificateUrl), readFile(keyUrl),
    ])
    const bytes = Buffer.from('contained source')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    let storageRequestStarted = false
    const database = new DatabaseSync(':memory:')
    database.exec(`
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          worker_id TEXT,
          lease_token TEXT,
          mutation_permit TEXT
        );
        INSERT INTO jobs(id, state, attempt)
          VALUES ('job_upload', 'queued', 0);
    `)
    const server = createHttpsServer({ cert: certificate, key }, (request, response) => {
      const chunks: Buffer[] = []
      let length = 0
      request.on('data', (raw) => {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
        length += chunk.byteLength
        if (length <= 16 * 1024) chunks.push(chunk)
      })
      request.on('end', () => {
        let body: Record<string, unknown>
        try {
          body = JSON.parse(Buffer.concat(chunks, length).toString('utf8'))
        } catch {
          response.writeHead(400)
          response.end()
          return
        }
        const json = (value: unknown) => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(value))
        }
        if (request.url === '/rpc/autoforge_knowledge_claim_job') {
          const changed = database.prepare(`
              UPDATE jobs SET state = 'running', attempt = attempt + 1,
                worker_id = ?, lease_token = ?, mutation_permit = ?
              WHERE id = 'job_upload' AND state = 'queued'
          `).run(body.p_worker_id, body.p_lease_token, 'permit_job_upload')
          expect(changed.changes).toBe(1)
          json({ job: {
            id: 'job_upload', kind: 'upload', entityId: 'upload_entity',
            leaseToken: body.p_lease_token, attempt: 1,
            mutationPermit: 'permit_job_upload', mutationBudgetMs: 5_500,
          } })
          return
        }
        if (request.url === '/rpc/autoforge_knowledge_get_upload_work') {
          json({
            ownerId: '1', knowledgeBaseId: 'kb_1', documentId: 'document_1',
            versionId: 'version_1', generationId: 'generation_1', objectId: 'object_1',
            storageReference: 'knowledge/1/kb_1/object_1', byteSize: bytes.byteLength,
            sha256, mimeType: 'text/plain', name: 'cloud.txt', versionNumber: 1,
          })
          return
        }
        if (request.url === '/objects/read') {
          storageRequestStarted = true
          return
        }
        if (request.url === '/rpc/autoforge_knowledge_complete_job') {
          const changed = database.prepare(`
              UPDATE jobs SET state = 'queued', worker_id = NULL,
                lease_token = NULL, mutation_permit = NULL
              WHERE id = ? AND state = 'running' AND worker_id = ?
                AND lease_token = ? AND mutation_permit = ?
          `).run(
            body.p_job_id, body.p_worker_id, body.p_lease_token, body.p_mutation_permit,
          )
          expect(changed.changes).toBe(1)
          json({ completed: true })
          return
        }
        if (request.url === '/rpc/autoforge_knowledge_cleanup_retention') {
          json({
            prunedChanges: 0, prunedTombstones: 0, prunedSnapshots: 0,
            prunedGenerations: 0, prunedDispatchPermits: 0,
          })
          return
        }
        response.writeHead(500)
        response.end()
      })
    })
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise)
      server.listen(0, '127.0.0.1', resolvePromise)
    })
    const address = server.address()
    expect(address).not.toBeNull()
    if (!address || typeof address === 'string') throw new Error('HTTPS fixture did not bind')

    let scheduler: ReturnType<typeof spawn> | undefined
    try {
      const baseUrl = `https://127.0.0.1:${address.port}`
      const entry = fileURLToPath(new URL(
        '../../cloudbase/knowledge/index.js', import.meta.url,
      ))
      const runner = `const { main } = require(${JSON.stringify(entry)}); main().then(`
        + `result => process.stdout.write(JSON.stringify({ pid: process.pid, result })), `
        + `error => { process.stderr.write(String(error?.stack ?? error)); process.exitCode = 1 })`
      scheduler = spawn(process.execPath, ['--no-addons', '-e', runner], {
        env: {
        AUTOFORGE_PG_RPC_BASE_URL: baseUrl,
        AUTOFORGE_PG_STORAGE_BASE_URL: baseUrl,
        AUTOFORGE_PG_SERVICE_KEY: 'test-service-key',
        AUTOFORGE_KNOWLEDGE_MUTATION_PERMIT_PORT_VERSION: 'db-job-v1',
        AUTOFORGE_KNOWLEDGE_WORKER_ID: 'worker_1',
        NODE_EXTRA_CA_CERTS: fileURLToPath(certificateUrl),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      scheduler.stdout?.setEncoding('utf8')
      scheduler.stderr?.setEncoding('utf8')
      scheduler.stdout?.on('data', chunk => { stdout += String(chunk) })
      scheduler.stderr?.on('data', chunk => { stderr += String(chunk) })
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolvePromise, rejectPromise) => {
          scheduler?.once('error', rejectPromise)
          scheduler?.once('close', (code, signal) => resolvePromise({ code, signal }))
        },
      )
      expect(exit).toEqual({ code: 0, signal: null })
      expect(stderr).toBe('')
      expect(JSON.parse(stdout)).toEqual({
        pid: expect.any(Number),
        result: { claimed: 1, completed: 0, failed: 1 },
      })
      expect(storageRequestStarted).toBe(true)
      expect(database.prepare(`
          SELECT state, attempt, worker_id, lease_token, mutation_permit
          FROM jobs WHERE id = 'job_upload'
      `).get()).toEqual({
        state: 'queued', attempt: 1, worker_id: null,
        lease_token: null, mutation_permit: null,
      })
    } finally {
      if (scheduler && scheduler.exitCode === null && scheduler.signalCode === null) {
        scheduler.kill('SIGKILL')
      }
      database.close()
      server.closeAllConnections()
      await new Promise<void>(resolvePromise => server.close(() => resolvePromise()))
    }
  }, 10_000)

  it.runIf(process.platform === 'darwin')(
    'settles the exact job after the default job spawn emits asynchronous EACCES',
    async () => {
      const certificateUrl = new URL(
        '../../apps/desktop/electron/main/media/test-fixtures/pinned-media-test-cert.pem',
        import.meta.url,
      )
      const keyUrl = new URL(
        '../../apps/desktop/electron/main/media/test-fixtures/pinned-media-test-key.pem',
        import.meta.url,
      )
      const [certificate, key] = await Promise.all([
        readFile(certificateUrl), readFile(keyUrl),
      ])
      const database = new DatabaseSync(':memory:')
      database.exec(`
          CREATE TABLE jobs (
            id TEXT PRIMARY KEY, state TEXT NOT NULL, attempt INTEGER NOT NULL,
            worker_id TEXT, lease_token TEXT, mutation_permit TEXT, error_code TEXT,
            settlement_kind TEXT, settlement_worker_id TEXT,
            settlement_lease_token TEXT, settlement_mutation_permit TEXT,
            settlement_state TEXT, settlement_error_code TEXT
          );
          INSERT INTO jobs(id, state, attempt) VALUES ('job_upload', 'queued', 0);
      `)
      const server = createHttpsServer({ cert: certificate, key }, (request, response) => {
        const chunks: Buffer[] = []
        request.on('data', raw => chunks.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw)))
        request.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, string>
          const json = (value: unknown) => {
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(JSON.stringify(value))
          }
          if (request.url === '/rpc/autoforge_knowledge_claim_job') {
            const changed = database.prepare(`
                UPDATE jobs SET state = 'running', attempt = attempt + 1,
                  worker_id = ?, lease_token = ?, mutation_permit = 'permit_job_upload'
                WHERE id = 'job_upload' AND state = 'queued'
            `).run(body.p_worker_id, body.p_lease_token)
            expect(changed.changes).toBe(1)
            json({ job: {
              id: 'job_upload', kind: 'upload', entityId: 'upload_entity',
              leaseToken: body.p_lease_token, attempt: 1,
              mutationPermit: 'permit_job_upload', mutationBudgetMs: 6_000,
            } })
            return
          }
          if (request.url === '/rpc/autoforge_knowledge_complete_job') {
            const changed = database.prepare(`
                UPDATE jobs SET state = 'queued', error_code = ?,
                  worker_id = NULL, lease_token = NULL, mutation_permit = NULL,
                  settlement_kind = 'complete', settlement_worker_id = ?,
                  settlement_lease_token = ?, settlement_mutation_permit = ?,
                  settlement_state = ?, settlement_error_code = ?
                WHERE id = ? AND state = 'running' AND attempt = 1
                  AND worker_id = ? AND lease_token = ? AND mutation_permit = ?
            `).run(
              body.p_error_code, body.p_worker_id, body.p_lease_token,
              body.p_mutation_permit, body.p_state, body.p_error_code,
              body.p_job_id, body.p_worker_id, body.p_lease_token, body.p_mutation_permit,
            )
            expect(changed.changes).toBe(1)
            json({ completed: true })
            return
          }
          if (request.url === '/rpc/autoforge_knowledge_cleanup_retention') {
            json({
              prunedChanges: 0, prunedTombstones: 0, prunedSnapshots: 0,
              prunedGenerations: 0, prunedDispatchPermits: 0,
            })
            return
          }
          response.writeHead(500)
          response.end()
        })
      })
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise)
        server.listen(0, '127.0.0.1', resolvePromise)
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('HTTPS fixture did not bind')

      try {
        await withAsyncEaccesExecutable(async (executablePath) => {
          const scheduler = startProductionScheduler(
            `https://127.0.0.1:${address.port}`, certificateUrl,
            { executablePath, moduleName: 'job-process.js' },
          )
          try {
            await expect(scheduler.output).resolves.toEqual({
              ok: true, pid: scheduler.child.pid,
              result: { claimed: 1, completed: 0, failed: 1 },
            })
            await expect(scheduler.closed).resolves.toEqual({ code: 0, signal: null })
            expect(scheduler.stderr()).toBe('')
            expect(database.prepare(`
                SELECT state, attempt, worker_id, lease_token, mutation_permit, error_code,
                  settlement_kind, settlement_worker_id, settlement_lease_token,
                  settlement_mutation_permit, settlement_state, settlement_error_code
                FROM jobs WHERE id = 'job_upload'
            `).get()).toEqual({
              state: 'queued', attempt: 1, worker_id: null, lease_token: null,
              mutation_permit: null, error_code: 'TRANSIENT_FAILURE',
              settlement_kind: 'complete', settlement_worker_id: 'worker_1',
              settlement_lease_token: expect.any(String),
              settlement_mutation_permit: 'permit_job_upload',
              settlement_state: 'failed', settlement_error_code: 'TRANSIENT_FAILURE',
            })
          } finally {
            if (scheduler.child.exitCode === null && scheduler.child.signalCode === null) {
              scheduler.child.kill('SIGKILL')
            }
            await scheduler.output.catch(() => undefined)
            await scheduler.closed.catch(() => undefined)
          }
        })
      } finally {
        database.close()
        server.closeAllConnections()
        await new Promise<void>(resolvePromise => server.close(() => resolvePromise()))
      }
    },
    10_000,
  )

  it.runIf(process.platform === 'darwin')(
    'replays the exact abandon after the default settlement spawn emits asynchronous EACCES',
    async () => {
      const certificateUrl = new URL(
        '../../apps/desktop/electron/main/media/test-fixtures/pinned-media-test-cert.pem',
        import.meta.url,
      )
      const keyUrl = new URL(
        '../../apps/desktop/electron/main/media/test-fixtures/pinned-media-test-key.pem',
        import.meta.url,
      )
      const [certificate, key] = await Promise.all([
        readFile(certificateUrl), readFile(keyUrl),
      ])
      const database = new DatabaseSync(':memory:')
      database.exec(`
          CREATE TABLE jobs (
            id TEXT PRIMARY KEY, state TEXT NOT NULL, attempt INTEGER NOT NULL,
            worker_id TEXT, lease_token TEXT, mutation_permit TEXT,
            settlement_kind TEXT, settlement_worker_id TEXT,
            settlement_lease_token TEXT, settlement_mutation_permit TEXT
          );
          INSERT INTO jobs(id, state, attempt) VALUES ('job_upload', 'queued', 0);
      `)
      const server = createHttpsServer({ cert: certificate, key }, (request, response) => {
        const chunks: Buffer[] = []
        request.on('data', raw => chunks.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw)))
        request.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, string>
          const json = (value: unknown) => {
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(JSON.stringify(value))
          }
          if (request.url === '/rpc/autoforge_knowledge_claim_job') {
            const changed = database.prepare(`
                UPDATE jobs SET state = 'running', attempt = attempt + 1,
                  worker_id = ?, lease_token = ?, mutation_permit = 'permit_job_upload'
                WHERE id = 'job_upload' AND state = 'queued'
            `).run(body.p_worker_id, body.p_lease_token)
            expect(changed.changes).toBe(1)
            json({ job: {
              id: 'job_upload', kind: 'upload', entityId: 'upload_entity',
              leaseToken: body.p_lease_token, attempt: 1,
              mutationPermit: 'permit_job_upload', mutationBudgetMs: 100,
            } })
            return
          }
          if (request.url === '/rpc/autoforge_knowledge_abandon_claimed_job') {
            const changed = database.prepare(`
                UPDATE jobs SET state = 'queued', attempt = attempt - 1,
                  worker_id = NULL, lease_token = NULL, mutation_permit = NULL,
                  settlement_kind = 'abandon', settlement_worker_id = ?,
                  settlement_lease_token = ?, settlement_mutation_permit = ?
                WHERE id = ? AND state = 'running' AND attempt = 1
                  AND worker_id = ? AND lease_token = ? AND mutation_permit = ?
            `).run(
              body.p_worker_id, body.p_lease_token, body.p_mutation_permit,
              body.p_job_id, body.p_worker_id, body.p_lease_token, body.p_mutation_permit,
            )
            expect(changed.changes).toBe(1)
            json({ abandoned: true })
            return
          }
          response.writeHead(500)
          response.end()
        })
      })
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise)
        server.listen(0, '127.0.0.1', resolvePromise)
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('HTTPS fixture did not bind')

      try {
        await withAsyncEaccesExecutable(async (executablePath) => {
          const scheduler = startProductionScheduler(
            `https://127.0.0.1:${address.port}`, certificateUrl,
            { executablePath, moduleName: 'settlement-process.js' },
          )
          try {
            await expect(scheduler.output).resolves.toEqual({
              ok: false, pid: scheduler.child.pid, code: 'TRANSIENT_FAILURE',
            })
            await expect(scheduler.closed).resolves.toEqual({ code: 0, signal: null })
            expect(scheduler.stderr()).toBe('')
            expect(database.prepare(`
                SELECT state, attempt, worker_id, lease_token, mutation_permit,
                  settlement_kind, settlement_worker_id, settlement_lease_token,
                  settlement_mutation_permit FROM jobs WHERE id = 'job_upload'
            `).get()).toEqual({
              state: 'queued', attempt: 0, worker_id: null, lease_token: null,
              mutation_permit: null, settlement_kind: 'abandon',
              settlement_worker_id: 'worker_1', settlement_lease_token: expect.any(String),
              settlement_mutation_permit: 'permit_job_upload',
            })
          } finally {
            if (scheduler.child.exitCode === null && scheduler.child.signalCode === null) {
              scheduler.child.kill('SIGKILL')
            }
            await scheduler.output.catch(() => undefined)
            await scheduler.closed.catch(() => undefined)
          }
        })
      } finally {
        database.close()
        server.closeAllConnections()
        await new Promise<void>(resolvePromise => server.close(() => resolvePromise()))
      }
    },
    10_000,
  )

  it.runIf(process.platform === 'darwin')(
    'kills a real stalled nested parser before the default scheduler settles its job',
    async () => {
      const certificateUrl = new URL(
        '../../apps/desktop/electron/main/media/test-fixtures/pinned-media-test-cert.pem',
        import.meta.url,
      )
      const keyUrl = new URL(
        '../../apps/desktop/electron/main/media/test-fixtures/pinned-media-test-key.pem',
        import.meta.url,
      )
      const [certificate, key] = await Promise.all([
        readFile(certificateUrl), readFile(keyUrl),
      ])
      const bytes = Buffer.alloc(16 * 1024 * 1024, 97)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const database = new DatabaseSync(':memory:')
      database.exec(`
          CREATE TABLE jobs (
            id TEXT PRIMARY KEY, state TEXT NOT NULL, attempt INTEGER NOT NULL,
            worker_id TEXT, lease_token TEXT, mutation_permit TEXT, error_code TEXT,
            settlement_kind TEXT, settlement_worker_id TEXT,
            settlement_lease_token TEXT, settlement_mutation_permit TEXT,
            settlement_state TEXT, settlement_error_code TEXT
          );
          INSERT INTO jobs(id, state, attempt) VALUES ('job_upload', 'queued', 0);
      `)
      let claimedLeaseToken: string | undefined
      let parserPid: number | undefined
      let parserAliveAtSettlement: boolean | undefined
      const server = createHttpsServer({ cert: certificate, key }, (request, response) => {
        const chunks: Buffer[] = []
        request.on('data', raw => chunks.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw)))
        request.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, string>
          const json = (value: unknown) => {
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(JSON.stringify(value))
          }
          if (request.url === '/rpc/autoforge_knowledge_claim_job') {
            claimedLeaseToken = body.p_lease_token
            const changed = database.prepare(`
                UPDATE jobs SET state = 'running', attempt = attempt + 1,
                  worker_id = ?, lease_token = ?, mutation_permit = 'permit_job_upload'
                WHERE id = 'job_upload' AND state = 'queued'
            `).run(body.p_worker_id, body.p_lease_token)
            expect(changed.changes).toBe(1)
            json({ job: {
              id: 'job_upload', kind: 'upload', entityId: 'upload_entity',
              leaseToken: body.p_lease_token, attempt: 1,
              mutationPermit: 'permit_job_upload', mutationBudgetMs: 8_000,
            } })
            return
          }
          if (request.url === '/rpc/autoforge_knowledge_get_upload_work') {
            json({
              ownerId: '1', knowledgeBaseId: 'kb_1', documentId: 'document_1',
              versionId: 'version_1', generationId: 'generation_1', objectId: 'object_1',
              storageReference: 'knowledge/1/kb_1/object_1', byteSize: bytes.byteLength,
              sha256, mimeType: 'text/plain', name: 'cloud.txt', versionNumber: 1,
            })
            return
          }
          if (request.url === '/objects/read') {
            response.writeHead(200, { 'content-type': 'application/octet-stream' })
            response.end(bytes)
            return
          }
          if (request.url === '/rpc/autoforge_knowledge_complete_job') {
            parserAliveAtSettlement = parserPid === undefined
              ? undefined : processIsAlive(parserPid)
            const current = database.prepare(`
                SELECT attempt FROM jobs WHERE id = ? AND state = 'running'
            `).get(body.p_job_id) as { attempt: number } | undefined
            const nextState = body.p_state === 'failed'
              && body.p_error_code === 'TRANSIENT_FAILURE'
              ? (current && current.attempt >= 3 ? 'failed' : 'queued')
              : body.p_state
            const changed = database.prepare(`
                UPDATE jobs SET state = ?, error_code = ?, worker_id = NULL,
                  lease_token = NULL, mutation_permit = NULL,
                  settlement_kind = 'complete', settlement_worker_id = ?,
                  settlement_lease_token = ?, settlement_mutation_permit = ?,
                  settlement_state = ?, settlement_error_code = ?
                WHERE id = ? AND state = 'running' AND attempt = 1 AND worker_id = ?
                  AND lease_token = ? AND mutation_permit = ?
            `).run(
              nextState, body.p_error_code, body.p_worker_id, body.p_lease_token,
              body.p_mutation_permit, body.p_state, body.p_error_code,
              body.p_job_id, body.p_worker_id, body.p_lease_token, body.p_mutation_permit,
            )
            expect(changed.changes).toBe(1)
            json({ completed: true })
            return
          }
          if (request.url === '/rpc/autoforge_knowledge_cleanup_retention') {
            json({
              prunedChanges: 0, prunedTombstones: 0, prunedSnapshots: 0,
              prunedGenerations: 0, prunedDispatchPermits: 0,
            })
            return
          }
          response.writeHead(500)
          response.end()
        })
      })
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise)
        server.listen(0, '127.0.0.1', resolvePromise)
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('HTTPS fixture did not bind')

      const scheduler = startProductionScheduler(`https://127.0.0.1:${address.port}`, certificateUrl)
      try {
        if (!scheduler.child.pid) throw new Error('Scheduler PID is unavailable')
        const jobChild = await waitForDescendant(
          scheduler.child.pid, row => row.command.includes('job-child.js'),
        )
        const parser = await waitForDescendant(
          scheduler.child.pid, row => row.command.includes('parser-child.js'),
        )
        parserPid = parser.pid
        expect(processIsAlive(parserPid)).toBe(true)
        expect(parser.state).not.toContain('T')
        process.kill(parserPid, 'SIGSTOP')
        const stoppedParser = await waitForStoppedProcess(parserPid)
        const schedulerRow = (await processRows()).find(row => row.pid === scheduler.child.pid)
        expect(jobChild.groupId).toBe(jobChild.pid)
        expect(stoppedParser.groupId).toBe(jobChild.groupId)
        expect(jobChild.groupId).not.toBe(schedulerRow?.groupId)

        await expect(scheduler.output).resolves.toEqual({
          ok: true, pid: scheduler.child.pid,
          result: { claimed: 1, completed: 0, failed: 1 },
        })
        expect(database.prepare(`
            SELECT state, attempt, worker_id, lease_token, mutation_permit, error_code,
              settlement_kind, settlement_worker_id, settlement_lease_token,
              settlement_mutation_permit, settlement_state, settlement_error_code
            FROM jobs WHERE id = 'job_upload'
        `).get()).toEqual({
          state: 'queued', attempt: 1, worker_id: null, lease_token: null,
          mutation_permit: null, error_code: 'TRANSIENT_FAILURE',
          settlement_kind: 'complete', settlement_worker_id: 'worker_1',
          settlement_lease_token: claimedLeaseToken,
          settlement_mutation_permit: 'permit_job_upload',
          settlement_state: 'failed', settlement_error_code: 'TRANSIENT_FAILURE',
        })
        expect(parserAliveAtSettlement).toBe(false)
        expect(processIsAlive(parserPid)).toBe(false)
      } finally {
        if (parserPid && processIsAlive(parserPid)) {
          try { process.kill(parserPid, 'SIGKILL') } catch { /* already gone */ }
        }
        if (scheduler.child.exitCode === null && scheduler.child.signalCode === null) {
          scheduler.child.kill('SIGKILL')
        }
        await scheduler.output.catch(() => undefined)
        bytes.fill(0)
        database.close()
        server.closeAllConnections()
        await new Promise<void>(resolvePromise => server.close(() => resolvePromise()))
      }
    },
    15_000,
  )

  it('replays a lost default completion response before runOnce returns', async () => {
    const certificateUrl = new URL(
      '../../apps/desktop/electron/main/media/test-fixtures/pinned-media-test-cert.pem',
      import.meta.url,
    )
    const keyUrl = new URL(
      '../../apps/desktop/electron/main/media/test-fixtures/pinned-media-test-key.pem',
      import.meta.url,
    )
    const [certificate, key] = await Promise.all([
      readFile(certificateUrl), readFile(keyUrl),
    ])
    const database = new DatabaseSync(':memory:')
    database.exec(`
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY, state TEXT NOT NULL, attempt INTEGER NOT NULL,
          worker_id TEXT, lease_token TEXT, mutation_permit TEXT,
          settlement_kind TEXT, settlement_worker_id TEXT,
          settlement_lease_token TEXT, settlement_mutation_permit TEXT,
          settlement_state TEXT, settlement_error_code TEXT
        );
        INSERT INTO jobs(id, state, attempt) VALUES ('job_upload', 'queued', 0);
    `)
    let completionRequests = 0
    let claimedLeaseToken: string | undefined
    let firstLateMutationApplied = false
    let resolveFirstLate: (() => void) | undefined
    const firstLate = new Promise<void>(resolvePromise => { resolveFirstLate = resolvePromise })
    const applyCompletion = (body: Record<string, string>): 'mutated' | 'receipt' | 'conflict' => {
      const changed = database.prepare(`
          UPDATE jobs SET state = 'queued', worker_id = NULL, lease_token = NULL,
            mutation_permit = NULL, settlement_kind = 'complete',
            settlement_worker_id = ?, settlement_lease_token = ?,
            settlement_mutation_permit = ?, settlement_state = ?,
            settlement_error_code = ?
          WHERE id = ? AND state = 'running' AND worker_id = ?
            AND lease_token = ? AND mutation_permit = ?
      `).run(
        body.p_worker_id, body.p_lease_token, body.p_mutation_permit,
        body.p_state, body.p_error_code, body.p_job_id, body.p_worker_id,
        body.p_lease_token, body.p_mutation_permit,
      )
      if (changed.changes === 1) return 'mutated'
      const receipt = database.prepare(`
          SELECT state, settlement_kind, settlement_worker_id,
            settlement_lease_token, settlement_mutation_permit,
            settlement_state, settlement_error_code
          FROM jobs WHERE id = ?
      `).get(body.p_job_id) as Record<string, unknown> | undefined
      return receipt?.state === 'queued' && receipt.settlement_kind === 'complete'
        && receipt.settlement_worker_id === body.p_worker_id
        && receipt.settlement_lease_token === body.p_lease_token
        && receipt.settlement_mutation_permit === body.p_mutation_permit
        && receipt.settlement_state === body.p_state
        && receipt.settlement_error_code === body.p_error_code
        ? 'receipt' : 'conflict'
    }
    const server = createHttpsServer({ cert: certificate, key }, (request, response) => {
      const chunks: Buffer[] = []
      request.on('data', raw => chunks.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw)))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, string>
        const json = (value: unknown) => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(value))
        }
        if (request.url === '/rpc/autoforge_knowledge_claim_job') {
          claimedLeaseToken = body.p_lease_token
          const changed = database.prepare(`
              UPDATE jobs SET state = 'running', attempt = attempt + 1,
                worker_id = ?, lease_token = ?, mutation_permit = 'permit_job_upload'
              WHERE id = 'job_upload' AND state = 'queued'
          `).run(body.p_worker_id, body.p_lease_token)
          expect(changed.changes).toBe(1)
          json({ job: {
            id: 'job_upload', kind: 'upload', entityId: 'upload_entity',
            leaseToken: body.p_lease_token, attempt: 1,
            mutationPermit: 'permit_job_upload', mutationBudgetMs: 6_000,
          } })
          return
        }
        if (request.url === '/rpc/autoforge_knowledge_get_upload_work') {
          response.writeHead(503, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ code: 'TRANSIENT_FAILURE' }))
          return
        }
        if (request.url === '/rpc/autoforge_knowledge_complete_job') {
          completionRequests += 1
          if (completionRequests === 1) {
            response.writeHead(200, { 'content-type': 'application/json' })
            response.flushHeaders()
            setTimeout(() => {
              firstLateMutationApplied = applyCompletion(body) === 'mutated'
              response.end(JSON.stringify({ completed: true }))
              resolveFirstLate?.()
            }, 4_500)
            return
          }
          expect(applyCompletion(body)).not.toBe('conflict')
          json({ completed: true })
          return
        }
        if (request.url === '/rpc/autoforge_knowledge_cleanup_retention') {
          json({
            prunedChanges: 0, prunedTombstones: 0, prunedSnapshots: 0,
            prunedGenerations: 0, prunedDispatchPermits: 0,
          })
          return
        }
        response.writeHead(500)
        response.end()
      })
    })
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise)
      server.listen(0, '127.0.0.1', resolvePromise)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('HTTPS fixture did not bind')

    const scheduler = startProductionScheduler(`https://127.0.0.1:${address.port}`, certificateUrl)
    try {
      await expect(scheduler.output).resolves.toEqual({
        ok: true, pid: scheduler.child.pid,
        result: { claimed: 1, completed: 0, failed: 1 },
      })
      const stateAtReturn = database.prepare(`
          SELECT state, worker_id, lease_token, mutation_permit, settlement_kind,
            settlement_worker_id, settlement_lease_token, settlement_mutation_permit,
            settlement_state, settlement_error_code
          FROM jobs WHERE id = 'job_upload'
      `).get()
      await firstLate

      expect(stateAtReturn).toEqual({
        state: 'queued', worker_id: null, lease_token: null, mutation_permit: null,
        settlement_kind: 'complete', settlement_worker_id: 'worker_1',
        settlement_lease_token: claimedLeaseToken,
        settlement_mutation_permit: 'permit_job_upload', settlement_state: 'failed',
        settlement_error_code: 'TRANSIENT_FAILURE',
      })
      expect(firstLateMutationApplied).toBe(false)
      expect(scheduler.stderr()).toBe('')
    } finally {
      if (scheduler.child.exitCode === null && scheduler.child.signalCode === null) {
        scheduler.child.kill('SIGKILL')
      }
      database.close()
      server.closeAllConnections()
      await new Promise<void>(resolvePromise => server.close(() => resolvePromise()))
    }
  }, 12_000)

  it('replays a stalled default low-budget abandon before runOnce rejects', async () => {
    const certificateUrl = new URL(
      '../../apps/desktop/electron/main/media/test-fixtures/pinned-media-test-cert.pem',
      import.meta.url,
    )
    const keyUrl = new URL(
      '../../apps/desktop/electron/main/media/test-fixtures/pinned-media-test-key.pem',
      import.meta.url,
    )
    const [certificate, key] = await Promise.all([
      readFile(certificateUrl), readFile(keyUrl),
    ])
    const database = new DatabaseSync(':memory:')
    database.exec(`
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY, state TEXT NOT NULL, attempt INTEGER NOT NULL,
          worker_id TEXT, lease_token TEXT, mutation_permit TEXT,
          settlement_kind TEXT, settlement_worker_id TEXT,
          settlement_lease_token TEXT, settlement_mutation_permit TEXT
        );
        INSERT INTO jobs(id, state, attempt) VALUES ('job_upload', 'queued', 0);
    `)
    let abandonRequests = 0
    let claimedLeaseToken: string | undefined
    const applyAbandon = (body: Record<string, string>): 'mutated' | 'receipt' | 'conflict' => {
      const changed = database.prepare(`
          UPDATE jobs SET state = 'queued', attempt = attempt - 1,
            worker_id = NULL, lease_token = NULL, mutation_permit = NULL,
            settlement_kind = 'abandon', settlement_worker_id = ?,
            settlement_lease_token = ?, settlement_mutation_permit = ?
          WHERE id = ? AND state = 'running' AND worker_id = ?
            AND lease_token = ? AND mutation_permit = ?
      `).run(
        body.p_worker_id, body.p_lease_token, body.p_mutation_permit,
        body.p_job_id, body.p_worker_id, body.p_lease_token, body.p_mutation_permit,
      )
      if (changed.changes === 1) return 'mutated'
      const receipt = database.prepare(`
          SELECT state, attempt, settlement_kind, settlement_worker_id,
            settlement_lease_token, settlement_mutation_permit
          FROM jobs WHERE id = ?
      `).get(body.p_job_id) as Record<string, unknown> | undefined
      return receipt?.state === 'queued' && receipt.attempt === 0
        && receipt.settlement_kind === 'abandon'
        && receipt.settlement_worker_id === body.p_worker_id
        && receipt.settlement_lease_token === body.p_lease_token
        && receipt.settlement_mutation_permit === body.p_mutation_permit
        ? 'receipt' : 'conflict'
    }
    const server = createHttpsServer({ cert: certificate, key }, (request, response) => {
      const chunks: Buffer[] = []
      request.on('data', raw => chunks.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw)))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, string>
        const json = (value: unknown) => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(value))
        }
        if (request.url === '/rpc/autoforge_knowledge_claim_job') {
          claimedLeaseToken = body.p_lease_token
          const changed = database.prepare(`
              UPDATE jobs SET state = 'running', attempt = attempt + 1,
                worker_id = ?, lease_token = ?, mutation_permit = 'permit_job_upload'
              WHERE id = 'job_upload' AND state = 'queued'
          `).run(body.p_worker_id, body.p_lease_token)
          expect(changed.changes).toBe(1)
          json({ job: {
            id: 'job_upload', kind: 'upload', entityId: 'upload_entity',
            leaseToken: body.p_lease_token, attempt: 1,
            mutationPermit: 'permit_job_upload', mutationBudgetMs: 100,
          } })
          return
        }
        if (request.url === '/rpc/autoforge_knowledge_abandon_claimed_job') {
          abandonRequests += 1
          if (abandonRequests <= 2) {
            response.writeHead(200, { 'content-type': 'application/json' })
            response.flushHeaders()
            return
          }
          expect(applyAbandon(body)).not.toBe('conflict')
          json({ abandoned: true })
          return
        }
        response.writeHead(500)
        response.end()
      })
    })
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise)
      server.listen(0, '127.0.0.1', resolvePromise)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('HTTPS fixture did not bind')

    const scheduler = startProductionScheduler(`https://127.0.0.1:${address.port}`, certificateUrl)
    try {
      const outcome = await Promise.race([
        scheduler.output.then(output => ({ kind: 'output' as const, output })),
        delay(3_500).then(() => ({ kind: 'timeout' as const })),
      ])
      const stateAtBoundary = database.prepare(`
          SELECT state, attempt, worker_id, lease_token, mutation_permit,
            settlement_kind, settlement_worker_id, settlement_lease_token,
            settlement_mutation_permit
          FROM jobs WHERE id = 'job_upload'
      `).get()

      expect({ outcome, stateAtBoundary }).toEqual({
        outcome: { kind: 'output', output: {
          ok: false, pid: scheduler.child.pid, code: 'TRANSIENT_FAILURE',
        } },
        stateAtBoundary: {
          state: 'queued', attempt: 0, worker_id: null, lease_token: null,
          mutation_permit: null, settlement_kind: 'abandon',
          settlement_worker_id: 'worker_1', settlement_lease_token: claimedLeaseToken,
          settlement_mutation_permit: 'permit_job_upload',
        },
      })
      expect(abandonRequests).toBe(3)
      expect(scheduler.stderr()).toBe('')
    } finally {
      if (scheduler.child.exitCode === null && scheduler.child.signalCode === null) {
        scheduler.child.kill('SIGKILL')
      }
      database.close()
      server.closeAllConnections()
      await new Promise<void>(resolvePromise => server.close(() => resolvePromise()))
    }
  }, 8_000)

  it('abandons the exact DB claim when transit consumes the settlement reserve', async () => {
    const database = new DatabaseSync(':memory:')
    try {
      database.exec(`
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          worker_id TEXT,
          lease_token TEXT,
          mutation_permit TEXT
        );
        INSERT INTO jobs(id, state, attempt)
          VALUES ('job_upload', 'queued', 0);
      `)
      let monotonicTime = 0
      const rpc = vi.fn(async (name: string, parameters: Record<string, unknown>) => {
        if (name === 'autoforge_knowledge_claim_job') {
          const changed = database.prepare(`
            UPDATE jobs SET state = 'running', attempt = attempt + 1,
              worker_id = ?, lease_token = ?, mutation_permit = ?
            WHERE id = 'job_upload' AND state = 'queued'
          `).run(
            parameters.p_worker_id, parameters.p_lease_token, 'permit_job_upload',
          )
          expect(changed.changes).toBe(1)
          monotonicTime = 90
          return {
            job: {
              id: 'job_upload', kind: 'upload', entityId: 'upload_entity',
              leaseToken: 'lease_job_upload', attempt: 1,
              mutationPermit: 'permit_job_upload', mutationBudgetMs: 100,
            },
          }
        }
        if (name === 'autoforge_knowledge_abandon_claimed_job') {
          const changed = database.prepare(`
            UPDATE jobs SET state = 'queued', attempt = attempt - 1,
              worker_id = NULL, lease_token = NULL, mutation_permit = NULL
            WHERE id = ? AND state = 'running' AND worker_id = ?
              AND lease_token = ? AND mutation_permit = ?
          `).run(
            parameters.p_job_id, parameters.p_worker_id,
            parameters.p_lease_token, parameters.p_mutation_permit,
          )
          expect(changed.changes).toBe(1)
          return { abandoned: true }
        }
        throw new Error(`unexpected rpc ${name}`)
      })
      const worker = createKnowledgeWorker({
        rpc, storage: { readObject: vi.fn(), deleteObjects: vi.fn() },
        parser: { parse: vi.fn() }, workerId: 'worker_1',
        id: () => 'lease_job_upload', jobTimeoutMs: 100,
        settlementReserveMs: 30, monotonicNow: () => monotonicTime,
      })

      await expect(worker.runOnce()).rejects.toEqual({ code: 'TRANSIENT_FAILURE' })
      expect(rpc).toHaveBeenCalledWith('autoforge_knowledge_abandon_claimed_job', {
        p_worker_id: 'worker_1', p_job_id: 'job_upload',
        p_lease_token: 'lease_job_upload', p_mutation_permit: 'permit_job_upload',
      })
      expect(database.prepare(`
        SELECT state, attempt, worker_id, lease_token, mutation_permit
        FROM jobs WHERE id = 'job_upload'
      `).get()).toEqual({
        state: 'queued', attempt: 0, worker_id: null,
        lease_token: null, mutation_permit: null,
      })
    } finally {
      database.close()
    }
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
    }, requestBoundary())
    expect(rpc).toHaveBeenNthCalledWith(3, 'autoforge_knowledge_complete_upload_index',
      expect.objectContaining({
        p_worker_id: 'worker_1', p_job_id: 'job_upload',
        p_lease_token: 'lease_job_upload', p_generation_id: 'generation_1',
        p_mutation_permit: expect.any(String),
        p_blocks: expect.any(Array), p_chunks: expect.any(Array),
      }), requestBoundary())
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
      p_mutation_permit: expect.any(String),
    }, requestBoundary())
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
        p_mutation_permit: expect.any(String),
      }, requestBoundary())
      if (expectedCode === 'TRANSIENT_FAILURE') {
        expect(rpc.mock.calls.filter(([name]) => (
          name === 'autoforge_knowledge_claim_job'
        ))).toHaveLength(1)
      }
    }
  })

  it('waits for the original parser abort acknowledgement before settling its lease', async () => {
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
      let parserDrained = false
      const worker = createKnowledgeWorker({
        rpc,
        storage: { readObject: vi.fn().mockResolvedValue(bytes), deleteObjects: vi.fn() },
        parser: { parse: vi.fn(({ signal }: { signal?: AbortSignal }) => {
          parserSignal = signal
          return new Promise<never>((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              setTimeout(() => {
                parserDrained = true
                reject({ code: 'TRANSIENT_FAILURE' })
              }, 5)
            }, { once: true })
          })
        }) },
        parserTimeoutMs: 50,
        workerId: 'worker_1', id: () => 'lease_job_upload',
      })

      const run = worker.runOnce()
      const beforeAck = Promise.race([
        run.then(() => 'settled' as const),
        new Promise<'unsettled'>(resolve => setTimeout(() => resolve('unsettled'), 51)),
      ])
      await vi.advanceTimersByTimeAsync(51)
      await expect(beforeAck).resolves.toBe('unsettled')
      expect(parserDrained).toBe(false)
      await vi.advanceTimersByTimeAsync(4)

      await expect(run).resolves.toEqual({ claimed: 1, completed: 0, failed: 1 })
      expect(parserDrained).toBe(true)
      expect(parserSignal?.aborted).toBe(true)
      expect(bytes.every(byte => byte === 0)).toBe(true)
      expect(rpc).toHaveBeenCalledWith('autoforge_knowledge_complete_job', {
        p_worker_id: 'worker_1', p_job_id: 'job_upload',
        p_lease_token: 'lease_job_upload', p_state: 'failed',
        p_error_code: 'TRANSIENT_FAILURE',
        p_mutation_permit: expect.any(String),
      }, requestBoundary())
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for the embedding transport abort acknowledgement before returning', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      let claims = 0
      let embeddingDrained = false
      const rpc = vi.fn().mockImplementation(async (name: string) => {
        if (name === 'autoforge_knowledge_claim_job') {
          claims += 1
          return claims === 1 ? claim('job_embedding', 'embedding') : { job: null }
        }
        if (name === 'autoforge_knowledge_complete_job') return { completed: true }
        if (name === 'autoforge_knowledge_cleanup_retention') return {
          prunedChanges: 0, prunedTombstones: 0, prunedSnapshots: 0,
          prunedGenerations: 0, prunedDispatchPermits: 0,
        }
        throw new Error(`unexpected rpc ${name}`)
      })
      const worker = createKnowledgeWorker({
        rpc, storage: { readObject: vi.fn(), deleteObjects: vi.fn() },
        parser: { parse: vi.fn() }, workerId: 'worker_1', id: () => 'lease_job_embedding',
        jobTimeoutMs: 100, settlementReserveMs: 30,
        embeddingWorker: { run: vi.fn((_input: unknown, boundary?: Boundary) => (
          new Promise<never>((_resolve, reject) => {
            boundary?.signal.addEventListener('abort', () => {
              setTimeout(() => {
                embeddingDrained = true
                reject({ code: 'TRANSIENT_FAILURE' })
              }, 5)
            }, { once: true })
          })
        )) },
      })

      const run = worker.runOnce()
      const beforeAck = Promise.race([
        run.then(() => 'settled' as const),
        new Promise<'unsettled'>(resolve => setTimeout(() => resolve('unsettled'), 71)),
      ])
      await vi.advanceTimersByTimeAsync(71)
      await expect(beforeAck).resolves.toBe('unsettled')
      expect(embeddingDrained).toBe(false)

      await vi.advanceTimersByTimeAsync(4)
      await expect(run).resolves.toEqual({ claimed: 1, completed: 0, failed: 1 })
      expect(embeddingDrained).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for the Storage delete abort acknowledgement before returning', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      let claims = 0
      let storageDrained = false
      const rpc = vi.fn().mockImplementation(async (name: string) => {
        if (name === 'autoforge_knowledge_claim_job') {
          claims += 1
          return claims === 1 ? claim('job_purge', 'purge') : { job: null }
        }
        if (name === 'autoforge_knowledge_prepare_base_purge') return {
          jobId: 'job_purge', storageReferences: ['knowledge/1/kb_1/object_1'],
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
          readObject: vi.fn(),
          deleteObjects: vi.fn((_references: unknown, boundary?: Boundary) => (
            new Promise<never>((_resolve, reject) => {
              boundary?.signal.addEventListener('abort', () => {
                setTimeout(() => {
                  storageDrained = true
                  reject({ code: 'TRANSIENT_FAILURE' })
                }, 5)
              }, { once: true })
            })
          )),
        },
        parser: { parse: vi.fn() }, workerId: 'worker_1', id: () => 'lease_job_purge',
        jobTimeoutMs: 100, settlementReserveMs: 30,
      })

      const run = worker.runOnce()
      const beforeAck = Promise.race([
        run.then(() => 'settled' as const),
        new Promise<'unsettled'>(resolve => setTimeout(() => resolve('unsettled'), 71)),
      ])
      await vi.advanceTimersByTimeAsync(71)
      await expect(beforeAck).resolves.toBe('unsettled')
      expect(storageDrained).toBe(false)

      await vi.advanceTimersByTimeAsync(4)
      await expect(run).resolves.toEqual({ claimed: 1, completed: 0, failed: 1 })
      expect(storageDrained).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['parser', 'upload'],
    ['Storage', 'upload'],
    ['embedding', 'embedding'],
  ] as const)(
    'terminates the current job containment when a never-settling %s ignores abort',
    async (stalled, kind) => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      try {
        const bytes = Buffer.from('contained source')
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        let claims = 0
        let ignoredSignal: AbortSignal | undefined
        let rejectOriginal: ((error: unknown) => void) | undefined
        let containmentTerminated = false
        let lateSideEffects = 0
        const neverSettling = (signal?: AbortSignal) => {
          ignoredSignal = signal
          setTimeout(() => {
            if (!containmentTerminated) lateSideEffects += 1
          }, 200)
          return new Promise<never>((_resolve, reject) => {
            rejectOriginal = reject
          })
        }
        const rpc = vi.fn(async (name: string) => {
          if (name === 'autoforge_knowledge_claim_job') {
            claims += 1
            return claims === 1 ? claim(`job_${kind}`, kind) : { job: null }
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
        const terminateJobExecution = vi.fn(async () => {
          containmentTerminated = true
          rejectOriginal?.({ code: 'TRANSIENT_FAILURE' })
        })
        const worker = createKnowledgeWorker({
          rpc,
          storage: {
            readObject: stalled === 'Storage'
              ? vi.fn((_input: unknown, boundary?: Boundary) => neverSettling(boundary?.signal))
              : vi.fn().mockResolvedValue(bytes),
            deleteObjects: vi.fn(),
          },
          parser: {
            parse: stalled === 'parser'
              ? vi.fn(({ signal }: { signal?: AbortSignal }) => neverSettling(signal))
              : vi.fn().mockResolvedValue({
                  parserVersion: 'cloud-parser-v1',
                  blocks: [{ id: 'block_1', ordinal: 0, kind: 'paragraph',
                    body: 'contained source', coordinates: { kind: 'txt' } }],
                  chunks: [{ id: 'chunk_1', blockId: 'block_1', ordinal: 0,
                    body: 'contained source', coordinates: { kind: 'txt' } }],
                }),
          },
          embeddingWorker: stalled === 'embedding'
            ? { run: vi.fn((_input: unknown, boundary?: Boundary) => (
                neverSettling(boundary?.signal)
              )) }
            : undefined,
          workerId: 'worker_1', id: () => `lease_job_${kind}`,
          jobTimeoutMs: 100, settlementReserveMs: 40,
          terminateJobExecution,
        })

        const run = worker.runOnce()
        const outcome = Promise.race([
          run.then(result => ({ kind: 'settled' as const, result })),
          new Promise<{ kind: 'unsettled' }>(resolve => {
            setTimeout(() => resolve({ kind: 'unsettled' }), 101)
          }),
        ])
        await vi.advanceTimersByTimeAsync(101)

        await expect(outcome).resolves.toEqual({
          kind: 'settled', result: { claimed: 1, completed: 0, failed: 1 },
        })
        expect(ignoredSignal?.aborted).toBe(true)
        expect(terminateJobExecution).toHaveBeenCalledWith({
          workerId: 'worker_1', jobId: `job_${kind}`, leaseToken: `lease_job_${kind}`,
        })
        expect(rpc).toHaveBeenCalledWith('autoforge_knowledge_complete_job', {
          p_worker_id: 'worker_1', p_job_id: `job_${kind}`,
          p_lease_token: `lease_job_${kind}`, p_state: 'failed',
          p_error_code: 'TRANSIENT_FAILURE', p_mutation_permit: expect.any(String),
        }, requestBoundary())

        await vi.advanceTimersByTimeAsync(500)
        expect(lateSideEffects).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it.each([-8_640_000_000, 8_640_000_000])(
    'uses the DB claim budget and opaque permit despite a client clock skew of %i ms',
    async (clientClock) => {
      vi.useFakeTimers()
      vi.setSystemTime(clientClock)
      try {
        type Boundary = {
          signal: AbortSignal
          timeoutMs: number
          remainingMs: () => number
          mutationAuthorization: {
            capability: string; workerId: string; jobId: string; leaseToken: string
          }
        }
        const bytes = Buffer.from('server-owned permit')
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        let claims = 0
        let monotonicTime = 0
        const boundaries: Boundary[] = []
        const rpc = vi.fn(async (
          name: string, parameters: Record<string, unknown>, boundary?: Boundary,
        ) => {
          if (name === 'autoforge_knowledge_claim_job') {
            claims += 1
            monotonicTime = 20
            return claims === 1 ? {
              job: {
                id: 'job_upload', kind: 'upload', entityId: 'upload_entity',
                leaseToken: 'lease_job_upload', attempt: 1,
                mutationPermit: 'opaque_server_permit', mutationBudgetMs: 100,
              },
            } : { job: null }
          }
          if (boundary) boundaries.push(boundary)
          if (name === 'autoforge_knowledge_get_upload_work') return {
            ownerId: '1', knowledgeBaseId: 'kb_1', documentId: 'document_1',
            versionId: 'version_1', generationId: 'generation_1', objectId: 'object_1',
            storageReference: 'knowledge/1/kb_1/object_1', byteSize: bytes.byteLength,
            sha256, mimeType: 'text/plain', name: 'cloud.txt', versionNumber: 1,
          }
          if (name === 'autoforge_knowledge_complete_upload_index') {
            expect(parameters).toMatchObject({ p_mutation_permit: 'opaque_server_permit' })
            expect(parameters).not.toHaveProperty('p_request_deadline_ms')
            return { completed: true, generationId: 'generation_1', embeddingJobId: null }
          }
          if (name === 'autoforge_knowledge_cleanup_retention') return {
            prunedChanges: 0, prunedTombstones: 0, prunedSnapshots: 0,
            prunedGenerations: 0, prunedDispatchPermits: 0,
          }
          throw new Error(`unexpected rpc ${name}`)
        })
        const storageBoundaries: Boundary[] = []
        const worker = createKnowledgeWorker({
          rpc,
          storage: {
            readObject: vi.fn((_input: unknown, boundary: Boundary) => {
              storageBoundaries.push(boundary)
              return Promise.resolve(bytes)
            }),
            deleteObjects: vi.fn(),
          },
          parser: { parse: vi.fn().mockResolvedValue({
            parserVersion: 'cloud-parser-v1',
            blocks: [{ id: 'block_1', ordinal: 0, kind: 'paragraph',
              body: 'server-owned permit', coordinates: { kind: 'txt' } }],
            chunks: [{ id: 'chunk_1', blockId: 'block_1', ordinal: 0,
              body: 'server-owned permit', coordinates: { kind: 'txt' } }],
          }) },
          workerId: 'worker_1', id: () => 'lease_job_upload',
          jobTimeoutMs: 100, settlementReserveMs: 30,
          monotonicNow: () => monotonicTime,
        })

        await expect(worker.runOnce()).resolves.toEqual({ claimed: 1, completed: 1, failed: 0 })
        expect(boundaries).toHaveLength(2)
        expect(storageBoundaries).toHaveLength(1)
        for (const boundary of [...boundaries, ...storageBoundaries]) {
          expect(boundary).toMatchObject({
            signal: expect.any(AbortSignal), timeoutMs: expect.any(Number),
            remainingMs: expect.any(Function),
            mutationAuthorization: {
              capability: 'opaque_server_permit', workerId: 'worker_1',
              jobId: 'job_upload', leaseToken: 'lease_job_upload',
            },
          })
          expect(Number.isSafeInteger(boundary.timeoutMs)).toBe(true)
          expect(boundary.remainingMs()).toBeGreaterThan(0)
          expect(boundary.remainingMs()).toBeLessThanOrEqual(50)
        }
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it.each([
    ['upload-work RPC', 'rpc'],
    ['Storage read', 'storage'],
    ['upload completion RPC', 'post-rpc'],
  ] as const)('shares the DB claim budget with a never-settling %s', async (_name, stalled) => {
    vi.useFakeTimers()
    try {
      const bytes = Buffer.from('claim deadline source')
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      let claims = 0
      const untilAbort = (boundary?: Boundary) => new Promise<never>((_resolve, reject) => {
        boundary?.signal.addEventListener('abort', () => {
          reject({ code: 'TRANSIENT_FAILURE' })
        }, { once: true })
      })
      const rpc = vi.fn().mockImplementation(async (
        name: string, _parameters: unknown, boundary?: Boundary,
      ) => {
        if (name === 'autoforge_knowledge_claim_job') {
          claims += 1
          return claims === 1 ? claim('job_upload', 'upload') : { job: null }
        }
        if (name === 'autoforge_knowledge_get_upload_work') {
          if (stalled === 'rpc') return untilAbort(boundary)
          return {
            ownerId: '1', knowledgeBaseId: 'kb_1', documentId: 'document_1',
            versionId: 'version_1', generationId: 'generation_1', objectId: 'object_1',
            storageReference: 'knowledge/1/kb_1/object_1', byteSize: bytes.byteLength,
            sha256, mimeType: 'text/plain', name: 'cloud.txt', versionNumber: 1,
          }
        }
        if (name === 'autoforge_knowledge_complete_upload_index') {
          if (stalled === 'post-rpc') return untilAbort(boundary)
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
            ? vi.fn((_input: unknown, boundary?: Boundary) => untilAbort(boundary))
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
        p_mutation_permit: expect.any(String),
      }, requestBoundary())
    } finally {
      vi.useRealTimers()
    }
  })

  it('prevents an ignored-abort upload completion from mutating after runOnce returns', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      const bytes = Buffer.from('late completion source')
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const workBoundaries: Array<Boundary | undefined> = []
      const storageBoundaries: Array<Boundary | undefined> = []
      let settlementBoundary: Boundary | undefined
      let completionPermit: string | undefined
      const workRemainingAtCall: number[] = []
      const storageRemainingAtCall: number[] = []
      let settlementRemainingAtCall: number | undefined
      let parserSignal: AbortSignal | undefined
      let lateCompletionSideEffects = 0
      let permitValid = true
      let rejectCompletion: ((error: unknown) => void) | undefined
      let claims = 0
      const rpc = vi.fn((name: string, parameters: unknown, boundary?: Boundary) => {
        if (name === 'autoforge_knowledge_claim_job') {
          claims += 1
          return Promise.resolve(claims === 1 ? claim('job_upload', 'upload') : { job: null })
        }
        if (name === 'autoforge_knowledge_get_upload_work') {
          workBoundaries.push(boundary)
          workRemainingAtCall.push(boundary?.remainingMs() ?? -1)
          return Promise.resolve({
            ownerId: '1', knowledgeBaseId: 'kb_1', documentId: 'document_1',
            versionId: 'version_1', generationId: 'generation_1', objectId: 'object_1',
            storageReference: 'knowledge/1/kb_1/object_1', byteSize: bytes.byteLength,
            sha256, mimeType: 'text/plain', name: 'cloud.txt', versionNumber: 1,
          })
        }
        if (name === 'autoforge_knowledge_complete_upload_index') {
          workBoundaries.push(boundary)
          workRemainingAtCall.push(boundary?.remainingMs() ?? -1)
          completionPermit = (parameters as { p_mutation_permit?: string }).p_mutation_permit
          return new Promise((resolve, reject) => {
            rejectCompletion = reject
            setTimeout(() => {
              if (permitValid && completionPermit === 'permit_job_upload') {
                lateCompletionSideEffects += 1
                resolve({ completed: true, generationId: 'generation_1', embeddingJobId: null })
              } else {
                reject({ code: 'CONFLICT' })
              }
            }, 200)
          })
        }
        if (name === 'autoforge_knowledge_complete_job') {
          settlementBoundary = boundary
          settlementRemainingAtCall = boundary?.remainingMs()
          return Promise.resolve({ completed: true })
        }
        if (name === 'autoforge_knowledge_cleanup_retention') return Promise.resolve({
          prunedChanges: 0, prunedTombstones: 0, prunedSnapshots: 0,
          prunedGenerations: 0, prunedDispatchPermits: 0,
        })
        throw new Error(`unexpected rpc ${name}`)
      })
      const worker = createKnowledgeWorker({
        rpc,
        storage: {
          readObject: vi.fn((_input: unknown, boundary?: Boundary) => {
            storageBoundaries.push(boundary)
            storageRemainingAtCall.push(boundary?.remainingMs() ?? -1)
            return Promise.resolve(bytes)
          }),
          deleteObjects: vi.fn(),
        },
        parser: { parse: vi.fn(({ signal }: { signal?: AbortSignal }) => {
          parserSignal = signal
          return Promise.resolve({
            parserVersion: 'cloud-parser-v1',
            blocks: [{ id: 'block_1', ordinal: 0, kind: 'paragraph', body: 'late completion source',
              coordinates: { kind: 'txt', lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 22 } }],
            chunks: [{ id: 'chunk_1', blockId: 'block_1', ordinal: 0,
              body: 'late completion source',
              coordinates: { kind: 'txt', lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 22 } }],
          })
        }) },
        workerId: 'worker_1', id: () => 'lease_job_upload',
        jobTimeoutMs: 100, settlementReserveMs: 30,
        terminateJobExecution: vi.fn(async () => {
          permitValid = false
          rejectCompletion?.({ code: 'TRANSIENT_FAILURE' })
        }),
      })

      const run = worker.runOnce()
      await vi.advanceTimersByTimeAsync(100)
      await expect(run).resolves.toEqual({ claimed: 1, completed: 0, failed: 1 })

      expect(workBoundaries).toHaveLength(2)
      expect(storageBoundaries).toHaveLength(1)
      expect(workRemainingAtCall.every(remaining => remaining >= 0 && remaining <= 70)).toBe(true)
      expect(storageRemainingAtCall[0]).toBeGreaterThanOrEqual(0)
      expect(storageRemainingAtCall[0]).toBeLessThanOrEqual(70)
      expect(workBoundaries[0]?.signal).toBe(workBoundaries[1]?.signal)
      expect(storageBoundaries[0]?.signal).toBe(workBoundaries[0]?.signal)
      expect(parserSignal).toBe(workBoundaries[0]?.signal)
      expect(workBoundaries[1]?.signal.aborted).toBe(true)
      expect(completionPermit).toBe('permit_job_upload')
      expect(settlementRemainingAtCall).toBeGreaterThan(0)
      expect(settlementBoundary?.signal.aborted).toBe(false)

      await vi.advanceTimersByTimeAsync(500)
      expect(lateCompletionSideEffects).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('prevents an ignored-abort failed settlement from mutating after runOnce returns', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      let claims = 0
      let settlementBoundary: Boundary | undefined
      let settlementPermit: string | undefined
      let settlementRemainingAtCall: number | undefined
      let lateSettlementSideEffects = 0
      let permitValid = true
      let rejectSettlement: ((error: unknown) => void) | undefined
      const rpc = vi.fn((name: string, parameters: unknown, boundary?: Boundary) => {
        if (name === 'autoforge_knowledge_claim_job') {
          claims += 1
          return Promise.resolve(claims === 1 ? claim('job_upload', 'upload') : { job: null })
        }
        if (name === 'autoforge_knowledge_get_upload_work') {
          return Promise.reject({ code: 'TRANSIENT_FAILURE' })
        }
        if (name === 'autoforge_knowledge_complete_job') {
          settlementBoundary = boundary
          settlementRemainingAtCall = boundary?.remainingMs()
          settlementPermit = (parameters as { p_mutation_permit?: string }).p_mutation_permit
          return new Promise((resolve, reject) => {
            rejectSettlement = reject
            setTimeout(() => {
              if (permitValid && settlementPermit === 'permit_job_upload') {
                lateSettlementSideEffects += 1
                resolve({ completed: true })
              } else {
                reject({ code: 'CONFLICT' })
              }
            }, 200)
          })
        }
        if (name === 'autoforge_knowledge_cleanup_retention') return Promise.resolve({
          prunedChanges: 0, prunedTombstones: 0, prunedSnapshots: 0,
          prunedGenerations: 0, prunedDispatchPermits: 0,
        })
        throw new Error(`unexpected rpc ${name}`)
      })
      const worker = createKnowledgeWorker({
        rpc,
        storage: { readObject: vi.fn(), deleteObjects: vi.fn() },
        parser: { parse: vi.fn() }, workerId: 'worker_1', id: () => 'lease_job_upload',
        jobTimeoutMs: 100, settlementReserveMs: 30,
        terminateJobExecution: vi.fn(async () => {
          permitValid = false
          rejectSettlement?.({ code: 'TRANSIENT_FAILURE' })
        }),
      })

      const run = worker.runOnce()
      await vi.advanceTimersByTimeAsync(100)
      await expect(run).resolves.toEqual({ claimed: 1, completed: 0, failed: 1 })
      expect(settlementRemainingAtCall).toBeGreaterThan(0)
      expect(settlementRemainingAtCall).toBeLessThanOrEqual(90)
      expect(settlementPermit).toBe('permit_job_upload')
      expect(settlementBoundary?.signal.aborted).toBe(true)

      await vi.advanceTimersByTimeAsync(500)
      expect(lateSettlementSideEffects).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('threads the claimed work boundary through purge and embedding-yield dependencies', async () => {
    const purgeRpcBoundaries: Array<Boundary | undefined> = []
    const purgeStorageBoundaries: Array<Boundary | undefined> = []
    let purgeClaims = 0
    const purgeWorker = createKnowledgeWorker({
      rpc: vi.fn((name: string, _parameters: unknown, boundary?: Boundary) => {
        if (name === 'autoforge_knowledge_claim_job') {
          purgeClaims += 1
          return Promise.resolve(purgeClaims === 1 ? claim('job_purge', 'purge') : { job: null })
        }
        if (name === 'autoforge_knowledge_prepare_base_purge') {
          purgeRpcBoundaries.push(boundary)
          return Promise.resolve({ jobId: 'job_purge', storageReferences: ['knowledge/1/kb_1/a'] })
        }
        if (name === 'autoforge_knowledge_complete_base_purge') {
          purgeRpcBoundaries.push(boundary)
          return Promise.resolve({ jobId: 'job_purge', completed: true })
        }
        if (name === 'autoforge_knowledge_cleanup_retention') return Promise.resolve({
          prunedChanges: 0, prunedTombstones: 0, prunedSnapshots: 0,
          prunedGenerations: 0, prunedDispatchPermits: 0,
        })
        throw new Error(`unexpected rpc ${name}`)
      }),
      storage: {
        readObject: vi.fn(),
        deleteObjects: vi.fn((_references: unknown, boundary?: Boundary) => {
          purgeStorageBoundaries.push(boundary)
          return Promise.resolve()
        }),
      },
      parser: { parse: vi.fn() }, workerId: 'worker_1', id: () => 'lease_job_purge',
    })
    await expect(purgeWorker.runOnce()).resolves.toEqual({ claimed: 1, completed: 1, failed: 0 })

    const embeddingBoundaries: Array<Boundary | undefined> = []
    const yieldBoundaries: Array<Boundary | undefined> = []
    let embeddingClaims = 0
    const embeddingWorker = createKnowledgeWorker({
      rpc: vi.fn((name: string, _parameters: unknown, boundary?: Boundary) => {
        if (name === 'autoforge_knowledge_claim_job') {
          embeddingClaims += 1
          return Promise.resolve(embeddingClaims === 1
            ? claim('job_embedding', 'embedding') : { job: null })
        }
        if (name === 'autoforge_knowledge_yield_job') {
          yieldBoundaries.push(boundary)
          return Promise.resolve({ yielded: true })
        }
        if (name === 'autoforge_knowledge_cleanup_retention') return Promise.resolve({
          prunedChanges: 0, prunedTombstones: 0, prunedSnapshots: 0,
          prunedGenerations: 0, prunedDispatchPermits: 0,
        })
        throw new Error(`unexpected rpc ${name}`)
      }),
      storage: { readObject: vi.fn(), deleteObjects: vi.fn() },
      parser: { parse: vi.fn() }, workerId: 'worker_1',
      embeddingWorker: { run: vi.fn((_input: unknown, boundary?: Boundary) => {
        embeddingBoundaries.push(boundary)
        return Promise.resolve({ state: 'partial', embedded: 2 })
      }) },
      id: () => 'lease_job_embedding',
    })
    await expect(embeddingWorker.runOnce()).resolves.toEqual({ claimed: 1, completed: 1, failed: 0 })

    expect(purgeRpcBoundaries).toHaveLength(2)
    expect(purgeStorageBoundaries).toHaveLength(1)
    expect(embeddingBoundaries).toHaveLength(1)
    expect(yieldBoundaries).toHaveLength(1)
    for (const boundary of [...purgeRpcBoundaries, ...purgeStorageBoundaries,
      ...embeddingBoundaries, ...yieldBoundaries]) {
      expect(boundary).toEqual(expect.objectContaining({
        signal: expect.any(AbortSignal), timeoutMs: expect.any(Number),
        remainingMs: expect.any(Function), mutationAuthorization: expect.objectContaining({
          capability: expect.any(String), workerId: 'worker_1',
          jobId: expect.any(String), leaseToken: expect.any(String),
        }),
      }))
    }
    expect(purgeRpcBoundaries[0]).toBe(purgeRpcBoundaries[1])
    expect(purgeStorageBoundaries[0]).toBe(purgeRpcBoundaries[0])
    expect(embeddingBoundaries[0]).toBe(yieldBoundaries[0])
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

  it('rejects a Brotli stream in the child before RSS enforcement has to kill it', async () => {
    const expanded = Buffer.alloc(160 * 1024 * 1024, 0x20)
    const compressed = brotliCompressSync(expanded, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 0 },
    })
    expanded.fill(0)
    const bytes = pdfFilteredFixture('BrotliDecode', compressed)
    compressed.fill(0)
    let kill: ReturnType<typeof vi.spyOn> | undefined
    const parser = createKnowledgeParserProcess({
      timeoutMs: 10_000,
      spawnImpl: (command, args, options) => {
        const childEntry = args.at(-1)
        const child = spawn(command, [
          ...args.slice(0, -1),
          '--eval', `delete globalThis.DecompressionStream; require(${JSON.stringify(childEntry)})`,
        ], options)
        kill = vi.spyOn(child, 'kill')
        return child
      },
    })

    await expect(parser.parse({
      bytes, mimeType: 'application/pdf', versionId: 'version_pdf_brotli_bomb',
    })).rejects.toEqual({ code: 'PARSER_LIMIT_EXCEEDED' })
    expect(kill).toBeDefined()
    expect(kill).not.toHaveBeenCalled()
    expect(bytes.every(byte => byte === 0)).toBe(true)
  })

  it.each([
    ['DCTDecode', Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0xff, 0xff, 0xff, 0xff, 3])],
    ['CCITTFaxDecode', Buffer.from([0xff, 0xff, 0xff, 0xff])],
    ['JBIG2Decode', Buffer.from([0x97, 0x4a, 0x42, 0x32, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['JPXDecode', Buffer.from([0xff, 0x4f, 0xff, 0x51, 0, 0, 0, 0])],
  ])('rejects direct %s content-stream decoding in a real child', async (filter, stream) => {
    const bytes = pdfFilteredFixture(filter, stream)
    stream.fill(0)
    const parser = createKnowledgeParserProcess({ timeoutMs: 3_000 })

    await expect(parser.parse({
      bytes, mimeType: 'application/pdf', versionId: `version_pdf_${filter}`,
    })).rejects.toEqual({ code: 'PARSER_LIMIT_EXCEEDED' })
    expect(bytes.every(byte => byte === 0)).toBe(true)
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
        mutationPermitPortVersion: 'db-job-v1',
        timeoutMs: 500,
        fetchImpl: vi.fn((_url: string, init: { signal: AbortSignal }) => {
          signal = init.signal
          return new Promise<never>((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
        }),
      })
      const read = storage.readObject({
        storageReference: 'knowledge/1/kb_1/object_1', byteSize: 4,
        sha256: 'a'.repeat(64), mimeType: 'text/plain',
      }, {
        signal: new AbortController().signal,
        timeoutMs: 500,
        remainingMs: () => 50,
        mutationAuthorization: {
          capability: 'opaque_server_permit', workerId: 'worker_1',
          jobId: 'job_upload', leaseToken: 'lease_job_upload',
        },
      })
      const outcome = Promise.race([
        read.then(
          () => ({ kind: 'resolved' as const }),
          error => ({ kind: 'rejected' as const, error }),
        ),
        new Promise<{ kind: 'unsettled' }>(resolve => {
          setTimeout(() => resolve({ kind: 'unsettled' }), 51)
        }),
      ])
      await vi.advanceTimersByTimeAsync(51)
      await expect(outcome).resolves.toEqual({
        kind: 'rejected', error: { code: 'TRANSIENT_FAILURE' },
      })
      expect(signal?.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the worker Storage mutation port closed without the DB permit contract', async () => {
    expect(() => createWorkerStorageClient({
      baseUrl: 'https://pg-storage.example/v1/storage', serviceKey: 'server-only',
    })).toThrow('Worker Storage mutation permit port is not configured')

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      headers: { get: vi.fn((name: string) => (
        name === 'x-autoforge-mutation-permit-validated' ? 'db-job-v1' : null
      )) },
    })
    const storage = createWorkerStorageClient({
      baseUrl: 'https://pg-storage.example/v1/storage', serviceKey: 'server-only',
      mutationPermitPortVersion: 'db-job-v1', fetchImpl,
    })
    const mutationAuthorization = {
      capability: 'opaque_server_permit', workerId: 'worker_1',
      jobId: 'job_purge', leaseToken: 'lease_job_purge',
    }
    await expect(storage.deleteObjects(['knowledge/1/kb_1/object_1'], {
      signal: new AbortController().signal,
      timeoutMs: 500,
      remainingMs: () => 100,
      mutationAuthorization,
    })).resolves.toBeUndefined()
    const request = fetchImpl.mock.calls[0]?.[1] as { headers: Record<string, string>; body: string }
    expect(request.headers).toMatchObject({
      'x-autoforge-mutation-permit-version': 'db-job-v1',
    })
    expect(JSON.parse(request.body)).toEqual({
      storageReferences: ['knowledge/1/kb_1/object_1'],
      mutationAuthorization,
    })
  })
})
