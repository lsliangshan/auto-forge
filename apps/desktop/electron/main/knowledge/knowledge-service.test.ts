import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { KnowledgeEntitlementState } from '@autoforge/shared'
import type { SafeStoragePort } from '../security/secret-store.js'
import { readEncryptedObjectSnapshot } from './encrypted-object-store.js'
import { openUserKnowledgeDatabase, type OpenedUserKnowledgeDatabase } from './encrypted-database.js'
import { KnowledgeKeyStore } from './key-store.js'
import { KnowledgeService, type KnowledgeParserPort } from './knowledge-service.js'
import { DEFAULT_PARSER_LIMITS, type ParserResponse } from './parser-protocol.js'
import { parseEncryptedDocument } from './parser-worker.js'

const directories: string[] = []

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(release => { resolve = release })
  return { promise, resolve }
}

function parsedText(jobId: string, text: string): ParserResponse {
  return {
    version: 1,
    type: 'result',
    jobId,
    text,
    blocks: [{
      id: 'block_1',
      text,
      coordinate: { kind: 'txt', lineStart: 1, lineEnd: 1, charStart: 0, charEnd: text.length },
    }],
    chunks: [{ index: 0, text, blockIds: ['block_1'] }],
  }
}

function safeStorage(): SafeStoragePort {
  return {
    isAvailable: async () => true,
    encrypt: async value => Buffer.from(value),
    decrypt: async value => ({ value: value.toString(), shouldReEncrypt: false }),
  }
}

class InProcessParser implements KnowledgeParserPort {
  terminated = false
  parseCalls = 0
  handler?: (input: Parameters<KnowledgeParserPort['parse']>[0]) => Promise<ParserResponse>
  onTerminate?: () => void

  async parse(input: Parameters<KnowledgeParserPort['parse']>[0]): Promise<ParserResponse> {
    this.parseCalls += 1
    if (this.handler) return this.handler(input)
    const encrypted = await readEncryptedObjectSnapshot(input.objectPath)
    const fileKey = Buffer.from(input.fileKey)
    input.fileKey.fill(0)
    return parseEncryptedDocument({
      version: 1,
      type: 'parse',
      jobId: input.jobId,
      format: input.format,
      encryptedBytes: Uint8Array.from(encrypted).buffer,
      fileKey: Uint8Array.from(fileKey).buffer,
      limits: DEFAULT_PARSER_LIMITS,
    })
  }

  async terminateAll(): Promise<void> {
    this.terminated = true
    this.onTerminate?.()
  }
}

async function fixture(options: {
  entitlement?: KnowledgeEntitlementState
  ownsConversation?: (userId: string, conversationId: string) => boolean
  unlinkKnowledgeObject?: (path: string) => Promise<void>
  vacuumKnowledgeDatabase?: (database: OpenedUserKnowledgeDatabase['database']) => void
  rotateKnowledgeDatabaseKey?: (opened: OpenedUserKnowledgeDatabase) => Promise<void>
} = {}) {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'autoforge-knowledge-service-'))
  directories.push(rootDirectory)
  const storage = safeStorage()
  const parsers: InProcessParser[] = []
  const picks: string[] = []
  const exports: string[] = []
  const createService = () => new KnowledgeService({
      rootDirectory,
      safeStorage: storage,
      createParser: async () => {
        const parser = new InProcessParser()
        parsers.push(parser)
        return parser
      },
      chooseImportFile: async () => picks.shift(),
      chooseExportPath: async () => exports.shift(),
      entitlement: {
        getEntitlement: async () => options.entitlement ?? {
          tier: 'free', status: 'active', betaEnabled: false, cloudEnabled: false,
        },
      },
      ownsConversation: async (owner, conversationId) => (
        options.ownsConversation?.(owner.userId, conversationId) ?? true
      ),
      platform: 'darwin',
      arch: 'arm64',
      unlinkKnowledgeObject: options.unlinkKnowledgeObject,
      vacuumKnowledgeDatabase: options.vacuumKnowledgeDatabase,
      rotateKnowledgeDatabaseKey: options.rotateKnowledgeDatabaseKey,
    })
  const service = createService()
  return { rootDirectory, storage, service, createService, parsers, picks, exports }
}

async function writeSource(root: string, name: string, content: string): Promise<string> {
  const path = join(root, name)
  await writeFile(path, content)
  return path
}

function findFile(root: string, name: string): string {
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()!
    const entries = readdirSync(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.name === name) return path
    }
  }
  throw new Error(`${name} not found`)
}

function findFileEnding(root: string, suffix: string): string {
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()!
    const entries = readdirSync(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.name.endsWith(suffix)) return path
    }
  }
  throw new Error(`${suffix} not found`)
}

function readStoredZipEntry(archive: Buffer, expectedName: string): Buffer {
  let offset = 0
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const byteSize = archive.readUInt32LE(offset + 18)
    const nameSize = archive.readUInt16LE(offset + 26)
    const extraSize = archive.readUInt16LE(offset + 28)
    const nameStart = offset + 30
    const bodyStart = nameStart + nameSize + extraSize
    if (archive.subarray(nameStart, nameStart + nameSize).toString() === expectedName) {
      return archive.subarray(bodyStart, bodyStart + byteSize)
    }
    offset = bodyStart + byteSize
  }
  throw new Error(`${expectedName} not found in archive`)
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('KnowledgeService lifecycle', () => {
  it('enables local storage only on the verified darwin arm64 runtime gate', async () => {
    const app = await fixture()
    await expect(app.service.getFeatureAvailability({ userId: 'alice' })).resolves.toEqual({
      local: { available: true, reasons: [] },
      cloud: { available: false, reasons: ['kill_switch_enabled'] },
    })
    expect(app.parsers).toHaveLength(1)
    expect(app.parsers[0]?.terminated).toBe(true)
    const probed = await openUserKnowledgeDatabase({
      rootDirectory: app.rootDirectory, userId: 'alice', safeStorage: app.storage,
    })
    expect(probed.database.prepare('SELECT count(*) AS count FROM knowledge_bases').get())
      .toEqual({ count: 0 })
    probed.close()
    const unavailable = new KnowledgeService({
      rootDirectory: app.rootDirectory,
      safeStorage: app.storage,
      createParser: async () => new InProcessParser(),
      chooseImportFile: async () => undefined,
      chooseExportPath: async () => undefined,
      ownsConversation: async () => true,
      platform: 'win32',
      arch: 'x64',
    })
    await expect(unavailable.getFeatureAvailability({ userId: 'alice' })).resolves.toMatchObject({
      local: { available: false, reasons: ['packaging_unverified'] },
      cloud: { available: false },
    })
    await expect(unavailable.listBases({ userId: 'alice' }))
      .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })

  it('maps real encrypted-storage, FTS, and parser probe failures to scoped unavailable reasons', async () => {
    const app = await fixture()
    const common = {
      rootDirectory: app.rootDirectory,
      safeStorage: app.storage,
      chooseImportFile: async () => undefined,
      chooseExportPath: async () => undefined,
      ownsConversation: async () => true,
      platform: 'darwin' as const,
      arch: 'arm64',
    }
    const parserUnavailable = new KnowledgeService({
      ...common,
      createParser: async () => { throw new Error('parser asset unavailable') },
    })
    await expect(parserUnavailable.getFeatureAvailability({ userId: 'alice' })).resolves.toMatchObject({
      local: { available: false, reasons: ['native_dependency_unavailable'] },
    })
    const ftsUnavailable = new KnowledgeService({
      ...common,
      createParser: async () => new InProcessParser(),
      openKnowledgeDatabase: async () => { throw new Error('Encrypted knowledge database requires FTS5') },
    })
    await expect(ftsUnavailable.getFeatureAvailability({ userId: 'alice' })).resolves.toMatchObject({
      local: { available: false, reasons: ['fts_unavailable'] },
    })
    const encryptedUnavailable = new KnowledgeService({
      ...common,
      createParser: async () => new InProcessParser(),
      openKnowledgeDatabase: async () => { throw new Error('encrypted driver failed') },
    })
    await expect(encryptedUnavailable.getFeatureAvailability({ userId: 'alice' })).resolves.toMatchObject({
      local: { available: false, reasons: ['encrypted_storage_unavailable'] },
    })
  })

  it('creates the lazy default library and enforces free 1-library/1-active-file limits in Main', async () => {
    const app = await fixture()
    const owner = { userId: 'alice' }

    const [defaultBase] = await app.service.listBases(owner)
    expect(defaultBase).toMatchObject({ name: '我的知识库', kind: 'local', status: 'ready' })
    await expect(app.service.createBase(owner, 'Second')).rejects.toMatchObject({ code: 'CONFLICT' })

    app.picks.push(await writeSource(app.rootDirectory, 'first.txt', '北京政务服务指南'))
    await expect(app.service.importDocument(owner, defaultBase!.id)).resolves.toMatchObject({
      name: 'first.txt', status: 'parsing', versionCount: 1,
    })
    await expect.poll(async () => (await app.service.listDocuments(owner, defaultBase!.id))[0]?.status).toBe('ready')
    app.picks.push(await writeSource(app.rootDirectory, 'second.txt', '第二份文件'))
    await expect(app.service.importDocument(owner, defaultBase!.id)).rejects.toMatchObject({ code: 'CONFLICT' })
    await app.service.close()
  })

  it('treats an expired member entitlement as non-member for local write limits', async () => {
    const app = await fixture({
      entitlement: { tier: 'member', status: 'expired', betaEnabled: true, cloudEnabled: false },
    })
    const owner = { userId: 'alice' }
    await app.service.listBases(owner)
    await expect(app.service.createBase(owner, 'Second')).rejects.toMatchObject({ code: 'CONFLICT' })
    await app.service.close()
  })

  it('drains an in-flight session open before parser and database teardown, then permits a fresh scope', async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'autoforge-knowledge-opening-'))
    directories.push(rootDirectory)
    const parser = new InProcessParser()
    let release!: (value: KnowledgeParserPort) => void
    const firstParser = new Promise<KnowledgeParserPort>(resolve => { release = resolve })
    let factoryCalls = 0
    const service = new KnowledgeService({
      rootDirectory,
      safeStorage: safeStorage(),
      createParser: async () => {
        factoryCalls += 1
        return factoryCalls === 1 ? firstParser : new InProcessParser()
      },
      chooseImportFile: async () => undefined,
      chooseExportPath: async () => undefined,
      ownsConversation: async () => true,
      platform: 'darwin', arch: 'arm64',
    })
    const listing = service.listBases({ userId: 'alice' })
    await expect.poll(() => factoryCalls).toBe(1)
    const closing = service.close()
    release(parser)
    await expect(listing).resolves.toHaveLength(1)
    await closing
    expect(parser.terminated).toBe(true)
    await expect(service.listBases({ userId: 'alice' })).resolves.toHaveLength(1)
    expect(factoryCalls).toBe(2)
    await service.close()
  })

  it('denies cross-owner access and validates conversation selection ownership and selected bases', async () => {
    const app = await fixture({ ownsConversation: (userId, conversationId) => userId === 'alice' && conversationId === 'conversation_alice' })
    const alice = { userId: 'alice' }
    const [base] = await app.service.listBases(alice)

    await expect(app.service.listBases({ userId: 'bob' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(app.service.getConversationSelection(alice, 'conversation_bob')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(app.service.updateConversationSelection(alice, 'conversation_alice', {
      knowledgeBaseIds: ['foreign_base'], knowledgeMode: 'strict',
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(app.service.updateConversationSelection(alice, 'conversation_alice', {
      knowledgeBaseIds: [base!.id], knowledgeMode: 'strict',
    })).resolves.toEqual({ knowledgeBaseIds: [base!.id], knowledgeMode: 'strict' })
    await app.service.close()
  })

  it('keeps the prior ready version searchable until atomic replacement publication and rolls back failures', async () => {
    const app = await fixture()
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    app.picks.push(await writeSource(app.rootDirectory, 'policy.txt', '旧政策北京政务服务'))
    const imported = await app.service.importDocument(owner, base!.id)
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status).toBe('ready')
    await app.service.updateConversationSelection(owner, 'conversation_1', {
      knowledgeBaseIds: [base!.id], knowledgeMode: 'mixed',
    })

    let release!: (response: ParserResponse) => void
    app.parsers[0]!.handler = input => new Promise(resolve => {
      release = resolve
      input.fileKey.fill(0)
    })
    app.picks.push(await writeSource(app.rootDirectory, 'policy-new.txt', '新政策北京政务办理'))
    const replacing = app.service.replaceDocument(owner, imported!.id)
    await expect.poll(async () => (await app.service.listVersions(owner, imported!.id)).length).toBe(2)
    expect((await app.service.search(owner, 'conversation_1', '旧政策')).results).toHaveLength(1)
    expect((await app.service.listDocuments(owner, base!.id))[0]?.name).toBe('policy.txt')
    expect((await app.service.search(owner, 'conversation_1', '新政策')).results).toHaveLength(0)
    release({ version: 1, type: 'error', jobId: 'ignored', code: 'PARSER_MALFORMED_DOCUMENT' })
    await expect(replacing).resolves.toMatchObject({ status: 'parsing' })
    await expect.poll(async () => (await app.service.listVersions(owner, imported!.id))[0]?.status).toBe('failed')
    expect((await app.service.search(owner, 'conversation_1', '旧政策')).results).toHaveLength(1)
    expect(await app.service.listVersions(owner, imported!.id)).toEqual([
      expect.objectContaining({ number: 2, status: 'failed' }),
      expect.objectContaining({ number: 1, status: 'ready' }),
    ])

    app.parsers[0]!.handler = undefined
    app.picks.push(await writeSource(app.rootDirectory, 'policy-final.txt', '新政策北京政务办理'))
    await expect(app.service.replaceDocument(owner, imported!.id)).resolves.toMatchObject({ status: 'parsing', versionCount: 3 })
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status).toBe('ready')
    expect((await app.service.search(owner, 'conversation_1', '旧政策')).results).toHaveLength(0)
    expect((await app.service.search(owner, 'conversation_1', '新政策')).results).toHaveLength(1)
    await app.service.close()
  })

  it('acknowledges a durable encrypted import before parsing completes and publishes it in the background', async () => {
    const app = await fixture()
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    const started = deferred<Parameters<KnowledgeParserPort['parse']>[0]>()
    const finish = deferred<ParserResponse>()
    app.parsers[0]!.handler = async input => {
      started.resolve(input)
      return finish.promise
    }
    app.picks.push(await writeSource(app.rootDirectory, 'background.txt', '后台导入北京政务'))

    let acknowledged: Awaited<ReturnType<KnowledgeService['importDocument']>> | undefined
    const importing = app.service.importDocument(owner, base!.id).then(value => { acknowledged = value; return value })
    const input = await started.promise
    await Promise.resolve()
    const acknowledgedBeforeParseFinished = acknowledged
    finish.resolve(parsedText(input.jobId, '后台导入北京政务'))
    await importing

    expect(acknowledgedBeforeParseFinished).toMatchObject({ status: 'parsing', versionCount: 1 })
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status).toBe('ready')
    await app.service.close()
  })

  it('cancels and drains a parsing import before recycling can become non-authoritative', async () => {
    const app = await fixture()
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    const started = deferred<Parameters<KnowledgeParserPort['parse']>[0]>()
    const finish = deferred<ParserResponse>()
    let drained = false
    app.parsers[0]!.handler = async input => {
      started.resolve(input)
      input.signal?.addEventListener('abort', () => {
        finish.resolve({ version: 1, type: 'error', jobId: input.jobId, code: 'PARSER_CANCELLED' })
      }, { once: true })
      try { return await finish.promise } finally { drained = true }
    }
    app.picks.push(await writeSource(app.rootDirectory, 'recycle-race.txt', '不可复活的回收内容'))
    const imported = await app.service.importDocument(owner, base!.id)
    const input = await started.promise

    const recycling = app.service.recycleDocument(owner, imported!.id)
    await new Promise(resolve => setImmediate(resolve))
    const abortedBeforeLifecycleReturned = input.signal?.aborted === true
    if (!abortedBeforeLifecycleReturned) finish.resolve(parsedText(input.jobId, '不可复活的回收内容'))
    await recycling
    await expect.poll(() => drained).toBe(true)

    expect(abortedBeforeLifecycleReturned).toBe(true)
    expect((await app.service.listDocuments(owner, base!.id))[0]?.status).toBe('deleted')
    await app.service.close()
  })

  it('cancels and drains a parsing import before purge removes its graph and object', async () => {
    const app = await fixture()
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    const started = deferred<Parameters<KnowledgeParserPort['parse']>[0]>()
    const finish = deferred<ParserResponse>()
    app.parsers[0]!.handler = async input => {
      started.resolve(input)
      return finish.promise
    }
    app.picks.push(await writeSource(app.rootDirectory, 'purge-race.txt', '不可复活的永久删除内容'))
    const imported = await app.service.importDocument(owner, base!.id)
    const input = await started.promise
    const objectPath = findFileEnding(app.rootDirectory, '.afobj')

    const purging = app.service.purgeDocument(owner, imported!.id)
    await expect.poll(() => input.signal?.aborted).toBe(true)
    app.picks.push(await writeSource(app.rootDirectory, 'purge-race-replacement.txt', '不得进入清除范围'))
    await expect(app.service.replaceDocument(owner, imported!.id)).rejects.toMatchObject({ code: 'CONFLICT' })
    finish.resolve({ version: 1, type: 'error', jobId: input.jobId, code: 'PARSER_CANCELLED' })
    await purging

    expect(await app.service.listDocuments(owner, base!.id)).toEqual([])
    await expect(readFile(objectPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await app.service.close()
  })

  it('uses authoritative generations so two replacements completing out of order keep the newest result', async () => {
    const app = await fixture()
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    app.picks.push(await writeSource(app.rootDirectory, 'original.txt', '初始政策北京政务'))
    const imported = await app.service.importDocument(owner, base!.id)
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status).toBe('ready')
    await app.service.updateConversationSelection(owner, 'conversation_1', {
      knowledgeBaseIds: [base!.id], knowledgeMode: 'mixed',
    })

    const pending: Array<{
      input: Parameters<KnowledgeParserPort['parse']>[0]
      finish: ReturnType<typeof deferred<ParserResponse>>
    }> = []
    app.parsers[0]!.handler = async input => {
      const finish = deferred<ParserResponse>()
      pending.push({ input, finish })
      return finish.promise
    }
    app.picks.push(await writeSource(app.rootDirectory, 'older.txt', '较旧替换北京政务'))
    await expect(app.service.replaceDocument(owner, imported!.id)).resolves.toMatchObject({ status: 'parsing' })
    await expect.poll(() => pending.length).toBe(1)
    app.picks.push(await writeSource(app.rootDirectory, 'newest.txt', '最新替换北京政务'))
    await expect(app.service.replaceDocument(owner, imported!.id)).resolves.toMatchObject({ status: 'parsing' })
    await expect.poll(() => pending.length).toBe(2)

    pending[1]!.finish.resolve(parsedText(pending[1]!.input.jobId, '最新替换北京政务'))
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.name).toBe('newest.txt')
    pending[0]!.finish.resolve(parsedText(pending[0]!.input.jobId, '较旧替换北京政务'))
    await expect.poll(async () => (await app.service.listVersions(owner, imported!.id))[0]?.status).toBe('ready')

    expect((await app.service.listDocuments(owner, base!.id))[0]).toMatchObject({ name: 'newest.txt', status: 'ready' })
    expect(await app.service.listVersions(owner, imported!.id)).toEqual([
      expect.objectContaining({ number: 3, status: 'ready' }),
      expect.objectContaining({ number: 2, status: 'failed' }),
      expect.objectContaining({ number: 1, status: 'retired' }),
    ])
    expect((await app.service.search(owner, 'conversation_1', '最新替换')).results).toHaveLength(1)
    expect((await app.service.search(owner, 'conversation_1', '较旧替换')).results).toHaveLength(0)
    await app.service.close()
  })

  it('recovers a durable interrupted import once and removes unreferenced managed object orphans', async () => {
    const app = await fixture()
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    const started = deferred<Parameters<KnowledgeParserPort['parse']>[0]>()
    const finish = deferred<ParserResponse>()
    app.parsers[0]!.handler = async input => { started.resolve(input); return finish.promise }
    app.parsers[0]!.onTerminate = () => {
      void started.promise.then(input => finish.resolve({
        version: 1, type: 'error', jobId: input.jobId, code: 'PARSER_CANCELLED',
      }))
    }
    app.picks.push(await writeSource(app.rootDirectory, 'resume.txt', '重启恢复北京政务'))
    const imported = await app.service.importDocument(owner, base!.id)
    await started.promise
    const managedPath = findFileEnding(app.rootDirectory, '.afobj')
    const orphanPath = join(dirname(managedPath), `${randomUUID()}.afobj`)
    await writeFile(orphanPath, 'orphan')
    await app.service.close()

    const reopened = app.createService()
    await reopened.listBases(owner)
    await expect.poll(async () => (await reopened.listDocuments(owner, base!.id))[0]?.status).toBe('ready')
    expect((await reopened.listDocuments(owner, base!.id))[0]).toMatchObject({ id: imported!.id, versionCount: 1 })
    await expect(readFile(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await reopened.close()

    const third = app.createService()
    await third.listBases(owner)
    await new Promise(resolve => setImmediate(resolve))
    expect(app.parsers.at(-1)?.parseCalls).toBe(0)
    expect((await third.listVersions(owner, imported!.id))).toHaveLength(1)
    await third.close()
  })

  it('reopens durable imports and selections while missing or replaced object keys fail closed', async () => {
    const app = await fixture()
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    app.picks.push(await writeSource(app.rootDirectory, 'durable.txt', '持久化北京政务知识'))
    await app.service.importDocument(owner, base!.id)
    await app.service.updateConversationSelection(owner, 'conversation_1', {
      knowledgeBaseIds: [base!.id], knowledgeMode: 'strict',
    })
    await app.service.close()

    const reopened = new KnowledgeService({
      rootDirectory: app.rootDirectory,
      safeStorage: app.storage,
      createParser: async () => new InProcessParser(),
      chooseImportFile: async () => undefined,
      chooseExportPath: async () => undefined,
      ownsConversation: async () => true,
      platform: 'darwin', arch: 'arm64',
    })
    expect(await reopened.getConversationSelection(owner, 'conversation_1')).toEqual({
      knowledgeBaseIds: [base!.id], knowledgeMode: 'strict',
    })
    expect((await reopened.search(owner, 'conversation_1', '北京政务')).results).toHaveLength(1)
    await reopened.close()

    const objectKeyPath = findFile(app.rootDirectory, 'knowledge-object-key.json')
    const saved = await readFile(objectKeyPath)
    await unlink(objectKeyPath)
    const missing = new KnowledgeService({
      rootDirectory: app.rootDirectory, safeStorage: app.storage,
      createParser: async () => new InProcessParser(), chooseImportFile: async () => undefined,
      chooseExportPath: async () => undefined, ownsConversation: async () => true,
      platform: 'darwin', arch: 'arm64',
    })
    await expect(missing.listBases(owner)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    await writeFile(objectKeyPath, saved)

    const keyStore = new KnowledgeKeyStore(objectKeyPath, app.storage)
    await keyStore.stagePendingKey(randomBytes(32))
    await keyStore.promotePendingKey()
    const wrong = new KnowledgeService({
      rootDirectory: app.rootDirectory, safeStorage: app.storage,
      createParser: async () => new InProcessParser(), chooseImportFile: async () => undefined,
      chooseExportPath: async () => undefined, ownsConversation: async () => true,
      platform: 'darwin', arch: 'arm64',
    })
    await expect(wrong.listBases(owner)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })

  it('exports originals plus a path-free manifest and purge rebuilds/rekeys without breaking retained objects', async () => {
    const app = await fixture({
      entitlement: { tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: false },
    })
    const owner = { userId: 'alice' }
    const base = await app.service.createBase(owner, 'Exportable')
    app.picks.push(await writeSource(app.rootDirectory, 'remove.txt', '删除内容'))
    const removed = await app.service.importDocument(owner, base.id)
    app.picks.push(await writeSource(app.rootDirectory, 'keep.txt', '保留内容北京政务'))
    await app.service.importDocument(owner, base.id)

    const databaseKeyPath = findFile(app.rootDirectory, 'knowledge-key.json')
    const keyBefore = readFileSync(databaseKeyPath, 'utf8')
    await app.service.recycleDocument(owner, removed!.id)
    await app.service.purgeDocument(owner, removed!.id)
    expect(readFileSync(databaseKeyPath, 'utf8')).not.toBe(keyBefore)

    const exportPath = join(app.rootDirectory, 'knowledge.zip')
    app.exports.push(exportPath)
    await app.service.exportBase(owner, base.id)
    const zip = await readFile(exportPath)
    expect(zip.subarray(0, 2).toString()).toBe('PK')
    expect(zip.includes(Buffer.from('manifest.json'))).toBe(true)
    expect(zip.includes(Buffer.from('keep.txt'))).toBe(true)
    expect(zip.includes(Buffer.from('保留内容北京政务'))).toBe(true)
    expect(zip.includes(Buffer.from(app.rootDirectory))).toBe(false)
    expect(zip.includes(Buffer.from(basename(databaseKeyPath)))).toBe(false)
    const manifestText = readStoredZipEntry(zip, 'manifest.json').toString()
    const manifest = JSON.parse(manifestText) as Record<string, unknown>
    expect(manifest).toMatchObject({
      formatVersion: 1,
      knowledgeBase: { id: base.id, name: 'Exportable' },
      documents: [{ name: 'keep.txt', versions: [{ number: 1, status: 'ready' }] }],
    })
    expect(manifestText).not.toMatch(/(?:relativeName|wrappedFileKey|localPath|sourcePath|vector|secret|url)/i)
    await app.service.close()
  })

  it('rejects an export whose encrypted version aggregate exceeds the fixed Main memory bound', async () => {
    const app = await fixture()
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    app.picks.push(await writeSource(app.rootDirectory, 'bounded.txt', 'bounded export'))
    await app.service.importDocument(owner, base!.id)
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status).toBe('ready')
    await app.service.close()
    const tamper = await openUserKnowledgeDatabase({
      rootDirectory: app.rootDirectory, userId: owner.userId, safeStorage: app.storage,
    })
    tamper.database.prepare('UPDATE source_objects SET byte_size = ?').run(128 * 1024 * 1024 + 1)
    tamper.close()

    const reopened = app.createService()
    const exportPath = join(app.rootDirectory, 'too-large.zip')
    app.exports.push(exportPath)
    await expect(reopened.exportBase(owner, base!.id)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(readFile(exportPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await reopened.close()
  })

  it.each(['unlink', 'vacuum', 'rekey'] as const)(
    'resumes a durable purge after a %s failure and restart without requiring the deleted graph',
    async (failureStep) => {
      let failed = false
      const app = await fixture({
        unlinkKnowledgeObject: async path => {
          if (failureStep === 'unlink' && !failed) {
            failed = true
            await unlink(path)
            throw new Error('injected unlink failure')
          }
          await unlink(path)
        },
        vacuumKnowledgeDatabase: database => {
          if (failureStep === 'vacuum' && !failed) {
            failed = true
            throw new Error('injected vacuum failure')
          }
          database.exec('VACUUM')
        },
        rotateKnowledgeDatabaseKey: async opened => {
          if (failureStep === 'rekey' && !failed) {
            failed = true
            throw new Error('injected rekey failure')
          }
          await opened.rotateKey()
        },
      })
      const owner = { userId: 'alice' }
      const [base] = await app.service.listBases(owner)
      app.picks.push(await writeSource(app.rootDirectory, `${failureStep}.txt`, `purge ${failureStep}`))
      const imported = await app.service.importDocument(owner, base!.id)
      await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status).toBe('ready')
      const objectPath = findFileEnding(app.rootDirectory, '.afobj')
      const databaseKeyPath = findFile(app.rootDirectory, 'knowledge-key.json')
      const keyBefore = await readFile(databaseKeyPath, 'utf8')

      await expect(app.service.purgeDocument(owner, imported!.id)).rejects.toThrow(`injected ${failureStep} failure`)
      await app.service.close()

      const reopened = app.createService()
      await expect(reopened.purgeDocument(owner, imported!.id)).resolves.toBeUndefined()
      expect(await reopened.listDocuments(owner, base!.id)).toEqual([])
      await expect(readFile(objectPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(databaseKeyPath, 'utf8')).not.toBe(keyBefore)
      await reopened.close()

      const inspected = await openUserKnowledgeDatabase({
        rootDirectory: app.rootDirectory, userId: owner.userId, safeStorage: app.storage,
      })
      expect(inspected.database.prepare('SELECT count(*) AS count FROM purge_operations').get())
        .toEqual({ count: 0 })
      inspected.close()
    },
  )

  it('validates every managed object name before committing purge graph deletion', async () => {
    const app = await fixture()
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    app.picks.push(await writeSource(app.rootDirectory, 'tampered.txt', 'tampered purge'))
    const imported = await app.service.importDocument(owner, base!.id)
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status).toBe('ready')
    const tamper = await openUserKnowledgeDatabase({
      rootDirectory: app.rootDirectory, userId: owner.userId, safeStorage: app.storage,
    })
    tamper.database.prepare("UPDATE source_objects SET relative_name = '../escape.afobj'").run()
    tamper.close()

    await expect(app.service.purgeDocument(owner, imported!.id)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(await app.service.listDocuments(owner, base!.id)).toHaveLength(1)
    await app.service.close()
  })

  it('removes every document and base tombstone scoped to a purged knowledge base', async () => {
    const app = await fixture({
      entitlement: { tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: false },
    })
    const owner = { userId: 'alice' }
    const base = await app.service.createBase(owner, 'Tombstones')
    for (const name of ['one.txt', 'two.txt']) {
      app.picks.push(await writeSource(app.rootDirectory, name, name))
      const imported = await app.service.importDocument(owner, base.id)
      await expect.poll(async () => (await app.service.listDocuments(owner, base.id))
        .find(document => document.id === imported!.id)?.status).toBe('ready')
      await app.service.recycleDocument(owner, imported!.id)
    }
    await app.service.recycleBase(owner, base.id)
    await app.service.purgeBase(owner, base.id)
    await app.service.close()

    const inspected = await openUserKnowledgeDatabase({
      rootDirectory: app.rootDirectory, userId: owner.userId, safeStorage: app.storage,
    })
    expect(inspected.database.prepare(
      'SELECT count(*) AS count FROM tombstones WHERE knowledge_base_id = ?',
    ).get(base.id)).toEqual({ count: 0 })
    inspected.close()
  })
})
