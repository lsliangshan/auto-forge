import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { KnowledgeEntitlementState } from '@autoforge/shared'
import type { SafeStoragePort } from '../security/secret-store.js'
import { readEncryptedObjectSnapshot } from './encrypted-object-store.js'
import { KnowledgeKeyStore } from './key-store.js'
import { KnowledgeService, type KnowledgeParserPort } from './knowledge-service.js'
import { DEFAULT_PARSER_LIMITS, type ParserResponse } from './parser-protocol.js'
import { parseEncryptedDocument } from './parser-worker.js'

const directories: string[] = []

function safeStorage(): SafeStoragePort {
  return {
    isAvailable: async () => true,
    encrypt: async value => Buffer.from(value),
    decrypt: async value => ({ value: value.toString(), shouldReEncrypt: false }),
  }
}

class InProcessParser implements KnowledgeParserPort {
  terminated = false
  handler?: (input: Parameters<KnowledgeParserPort['parse']>[0]) => Promise<ParserResponse>

  async parse(input: Parameters<KnowledgeParserPort['parse']>[0]): Promise<ParserResponse> {
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
  }
}

async function fixture(options: {
  entitlement?: KnowledgeEntitlementState
  ownsConversation?: (userId: string, conversationId: string) => boolean
} = {}) {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'autoforge-knowledge-service-'))
  directories.push(rootDirectory)
  const storage = safeStorage()
  const parsers: InProcessParser[] = []
  const picks: string[] = []
  const exports: string[] = []
  const service = new KnowledgeService({
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
  })
  return { rootDirectory, storage, service, parsers, picks, exports }
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

  it('creates the lazy default library and enforces free 1-library/1-active-file limits in Main', async () => {
    const app = await fixture()
    const owner = { userId: 'alice' }

    const [defaultBase] = await app.service.listBases(owner)
    expect(defaultBase).toMatchObject({ name: '我的知识库', kind: 'local', status: 'ready' })
    await expect(app.service.createBase(owner, 'Second')).rejects.toMatchObject({ code: 'CONFLICT' })

    app.picks.push(await writeSource(app.rootDirectory, 'first.txt', '北京政务服务指南'))
    await expect(app.service.importDocument(owner, defaultBase!.id)).resolves.toMatchObject({
      name: 'first.txt', status: 'ready', versionCount: 1,
    })
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
    await expect(replacing).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect((await app.service.search(owner, 'conversation_1', '旧政策')).results).toHaveLength(1)
    expect(await app.service.listVersions(owner, imported!.id)).toEqual([
      expect.objectContaining({ number: 2, status: 'failed' }),
      expect.objectContaining({ number: 1, status: 'ready' }),
    ])

    app.parsers[0]!.handler = undefined
    app.picks.push(await writeSource(app.rootDirectory, 'policy-final.txt', '新政策北京政务办理'))
    await expect(app.service.replaceDocument(owner, imported!.id)).resolves.toMatchObject({ status: 'ready', versionCount: 3 })
    expect((await app.service.search(owner, 'conversation_1', '旧政策')).results).toHaveLength(0)
    expect((await app.service.search(owner, 'conversation_1', '新政策')).results).toHaveLength(1)
    await app.service.close()
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
})
