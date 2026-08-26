import { createPrivateKey, randomBytes, randomUUID, sign } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  KnowledgeCitationPreview,
  KnowledgeCitationReference,
  KnowledgeEntitlementState,
  KnowledgeSearchOutcome,
  KnowledgeSearchResult,
} from '@autoforge/shared'
import type { SafeStoragePort } from '../security/secret-store.js'
import { createEncryptedObjectSnapshot, readEncryptedObjectSnapshot } from './encrypted-object-store.js'
import { KnowledgeEntitlementVerifier } from './entitlement-verifier.js'
import { openUserKnowledgeDatabase, type OpenedUserKnowledgeDatabase } from './encrypted-database.js'
import { KnowledgeKeyStore, removeFileDurably } from './key-store.js'
import type { KnowledgeReleaseAssessment } from './release-gates.js'
import {
  KnowledgeService,
  type KnowledgeEntitlementPort,
  type KnowledgeParserPort,
  type KnowledgeServiceOptions,
} from './knowledge-service.js'
import { DEFAULT_PARSER_LIMITS, type ParserResponse } from './parser-protocol.js'
import { parseEncryptedDocument } from './parser-worker.js'

const directories: string[] = []
const require = createRequire(import.meta.url)
const { createKnowledgeEntitlementSigner } = require('../../../../../cloudbase/knowledge/function/entitlement-envelope.js') as {
  createKnowledgeEntitlementSigner(deployment: Readonly<{
    keyId: string
    snapshotTtlMs: number
    now: () => number
    signCanonical: (bytes: Buffer) => Promise<Buffer>
  }>): (ownerId: string, databaseRecord: unknown) => Promise<unknown>
}
const ENTITLEMENT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA97YWmXI20+rOSQmtkgJIn0IbiaLrp6KZly2Enn0pyac=
-----END PUBLIC KEY-----
`
const ENTITLEMENT_PRIVATE_KEY = createPrivateKey(`-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIPw1EZH4rU2rAWoikip2sgTamPoODfyfnO4IDFB68He9
-----END PRIVATE KEY-----
`)

interface TargetKnowledgeCloudPort {
  getEntitlement(): Promise<KnowledgeEntitlementState & {
    killSwitchEnabled: boolean
    version: number
    validUntil: string | null
  }>
  getEmbeddingConsent(): Promise<{
    processor: 'tokenhub'
    processingRegion: 'Guangzhou'
    model: 'kinfra-text-embedding-0.6b'
    dimensions: 1024
    status: 'unknown' | 'granted' | 'denied' | 'revoked'
    retrievalByBase: Array<{
      knowledgeBaseId: string
      retrievalMode: 'hybrid' | 'keyword_only' | 'reindexing'
    }>
    updatedAt?: string
  }>
  setEmbeddingConsent(input: {
    requestId: string
    status: 'granted' | 'denied' | 'revoked'
  }): ReturnType<TargetKnowledgeCloudPort['getEmbeddingConsent']>
  capturePublishedSnapshot(input: { knowledgeBaseIds: string[] }): Promise<Array<{
    knowledgeBaseId: string
    generationId: string
  }>>
  searchPublished(input: {
    query: string
    generationSnapshot: Array<{ knowledgeBaseId: string; generationId: string }>
    topK: number
  }): Promise<{
    mode: 'hybrid' | 'keyword_only'
    degradationReason: null | 'consent_unavailable' | 'provider_unavailable' | 'model_deprecated' | 'small_index_limit'
    results: Array<{ generationId: string; evidence: KnowledgeSearchResult }>
  }>
}

type TargetEmbeddingConsent = Awaited<ReturnType<TargetKnowledgeCloudPort['getEmbeddingConsent']>>
type TargetCloudEntitlement = Awaited<ReturnType<TargetKnowledgeCloudPort['getEntitlement']>>
type TargetCloudSearch = Awaited<ReturnType<TargetKnowledgeCloudPort['searchPublished']>>

interface TargetSearchSnapshot {
  readonly selected: boolean
  readonly knowledgeMode: 'mixed' | 'strict'
}

interface TargetSnapshotKnowledgeService {
  captureSearchSnapshot(
    owner: { userId: string },
    conversationId: string,
  ): Promise<TargetSearchSnapshot>
  searchSnapshot(
    owner: { userId: string },
    snapshot: TargetSearchSnapshot,
    query: string,
  ): Promise<KnowledgeSearchOutcome>
  previewCitation(
    owner: { userId: string },
    citation: KnowledgeCitationReference,
  ): Promise<KnowledgeCitationPreview>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(release => { resolve = release })
  return { promise, resolve }
}

function revisionEntitlement(initial: KnowledgeEntitlementState) {
  let entitlement = initial
  let revision = 1
  const port = {
    getEntitlement: async () => entitlement,
    getAuthorizationSnapshot: async () => ({ entitlement, revision }),
    isAuthorizationSnapshotCurrent: async (_owner: { userId: string }, expected: {
      entitlement: KnowledgeEntitlementState
      revision: number
    }) => (
      expected.revision === revision && expected.entitlement === entitlement
    ),
    isAuthorizationSnapshotCurrentNow: (_owner: { userId: string }, expected: {
      entitlement: KnowledgeEntitlementState
      revision: number
    }) => expected.revision === revision && expected.entitlement === entitlement,
  }
  return {
    port: port as KnowledgeEntitlementPort & typeof port,
    update(next: KnowledgeEntitlementState) {
      entitlement = next
      revision += 1
    },
  }
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
  lastTimeoutMs?: number
  handler?: (input: Parameters<KnowledgeParserPort['parse']>[0]) => Promise<ParserResponse>
  onTerminate?: () => void

  async parse(input: Parameters<KnowledgeParserPort['parse']>[0]): Promise<ParserResponse> {
    this.parseCalls += 1
    this.lastTimeoutMs = input.timeoutMs
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
  entitlementPort?: KnowledgeEntitlementPort
  cloud?: TargetKnowledgeCloudPort
  ownsConversation?: (userId: string, conversationId: string) => boolean
  unlinkKnowledgeObject?: (path: string) => Promise<void>
  vacuumKnowledgeDatabase?: (database: OpenedUserKnowledgeDatabase['database']) => void
  rotateKnowledgeDatabaseKey?: (opened: OpenedUserKnowledgeDatabase) => Promise<void>
  createObjectSnapshot?: typeof createEncryptedObjectSnapshot
  removeKnowledgeObjectDurably?: (path: string) => Promise<void>
  now?: () => number
  getChatProviderConsent?: () => Promise<{
    provider: 'openrouter'
    status: 'unknown'
  }>
  releaseAssessment?: KnowledgeReleaseAssessment
} = {}) {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'autoforge-knowledge-service-'))
  directories.push(rootDirectory)
  const storage = safeStorage()
  const parsers: InProcessParser[] = []
  const picks: string[] = []
  const exports: string[] = []
  const createService = () => {
    const serviceOptions: KnowledgeServiceOptions = {
      rootDirectory,
      safeStorage: storage,
      createParser: async () => {
        const parser = new InProcessParser()
        parsers.push(parser)
        return parser
      },
      chooseImportFile: async () => picks.shift(),
      chooseExportPath: async () => exports.shift(),
      entitlement: options.entitlementPort ?? {
        getEntitlement: async () => options.entitlement ?? {
          tier: 'free', status: 'active', betaEnabled: false, cloudEnabled: false,
        },
      },
      cloud: options.cloud,
      getChatProviderConsent: options.getChatProviderConsent
        ?? (async () => ({ provider: 'openrouter' as const, status: 'unknown' as const })),
      ownsConversation: async (owner, conversationId) => (
        options.ownsConversation?.(owner.userId, conversationId) ?? true
      ),
      platform: 'darwin',
      arch: 'arm64',
      unlinkKnowledgeObject: options.unlinkKnowledgeObject,
      vacuumKnowledgeDatabase: options.vacuumKnowledgeDatabase,
      rotateKnowledgeDatabaseKey: options.rotateKnowledgeDatabaseKey,
      createObjectSnapshot: options.createObjectSnapshot,
      removeKnowledgeObjectDurably: options.removeKnowledgeObjectDurably,
      now: options.now,
      releaseAssessment: options.releaseAssessment ?? {
        betaEnabled: true, cloudEnabled: true, blockers: [],
      },
    }
    return new KnowledgeService(serviceOptions)
  }
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
  it('keeps a Signer-to-Verifier free owner writable at one local base and one logical file', async () => {
    const signer = createKnowledgeEntitlementSigner(Object.freeze({
      keyId: 'test-key-1', snapshotTtlMs: 60 * 60 * 1_000,
      now: () => Date.parse('2026-08-26T00:00:00.000Z'),
      signCanonical: async (bytes: Buffer) => sign(null, bytes, ENTITLEMENT_PRIVATE_KEY),
    }))
    const envelope = await signer('alice', {
      tier: 'free', status: 'active', betaEnabled: false, cloudEnabled: false,
      killSwitchEnabled: true, version: 0, validUntil: null,
    })
    const entitlement = new KnowledgeEntitlementVerifier({
      trustedKeys: { 'test-key-1': ENTITLEMENT_PUBLIC_KEY },
      now: () => Date.parse('2026-08-26T00:30:00.000Z'),
    }).verify('alice', envelope)
    const app = await fixture({ entitlement })
    const owner = { userId: 'alice' }

    await expect(app.service.getEntitlement(owner)).resolves.toEqual({
      tier: 'free', status: 'active', betaEnabled: false, cloudEnabled: false,
      knowledgeToolEnabled: false, killSwitchEnabled: true,
    })
    const [base] = await app.service.listBases(owner)
    app.picks.push(await writeSource(app.rootDirectory, 'signed-free.txt', '签名免费文件'))
    const document = await app.service.importDocument(owner, base!.id)
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status)
      .toBe('ready')
    app.picks.push(await writeSource(app.rootDirectory, 'signed-free-replaced.txt', '签名免费替换'))
    await expect(app.service.replaceDocument(owner, document!.id)).resolves.toBeDefined()
    await expect(app.service.createBase(owner, '第二库')).rejects.toMatchObject({ code: 'CONFLICT' })
    await app.service.close()
  })

  it('captures immutable selection and ready-version scope for the whole Agent turn', async () => {
    const app = await fixture({
      entitlement: {
        tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: false,
        knowledgeToolEnabled: true, killSwitchEnabled: false,
      },
    })
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    app.picks.push(await writeSource(app.rootDirectory, 'policy-old.txt', '旧版政策明确要求提前申请'))
    const document = await app.service.importDocument(owner, base!.id)
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status).toBe('ready')
    await app.service.updateConversationSelection(owner, 'conversation_1', {
      knowledgeBaseIds: [base!.id], knowledgeMode: 'strict',
    })
    const target = app.service as unknown as TargetSnapshotKnowledgeService

    const snapshot = await target.captureSearchSnapshot(owner, 'conversation_1')
    app.picks.push(await writeSource(app.rootDirectory, 'policy-new.txt', '新版政策改为线上提交'))
    await app.service.replaceDocument(owner, document!.id)
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.name).toBe('policy-new.txt')
    await app.service.updateConversationSelection(owner, 'conversation_1', {
      knowledgeBaseIds: [], knowledgeMode: 'mixed',
    })

    expect(snapshot).toMatchObject({ selected: true, knowledgeMode: 'strict' })
    await expect(target.searchSnapshot(owner, snapshot, '旧版政策')).resolves.toMatchObject({
      kind: 'results', results: [expect.objectContaining({ versionId: expect.any(String) })],
    })
    await expect(target.searchSnapshot(owner, snapshot, '新版政策')).resolves.toEqual({
      kind: 'results', results: [],
    })
    await expect(app.service.search(owner, 'conversation_1', '旧版政策')).resolves.toEqual({
      kind: 'results', results: [],
    })
    await app.service.close()
  })

  it('ANDs Main release admission after valid member and server authorization', async () => {
    const signer = createKnowledgeEntitlementSigner(Object.freeze({
      keyId: 'test-key-1', snapshotTtlMs: 60 * 60 * 1_000,
      now: () => Date.parse('2026-08-26T00:00:00.000Z'),
      signCanonical: async (bytes: Buffer) => sign(null, bytes, ENTITLEMENT_PRIVATE_KEY),
    }))
    const envelope = await signer('alice', {
      tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true,
      killSwitchEnabled: false, version: 1, validUntil: '2026-09-26T00:00:00.000Z',
    })
    const verifiedMember = new KnowledgeEntitlementVerifier({
      trustedKeys: { 'test-key-1': ENTITLEMENT_PUBLIC_KEY },
      now: () => Date.parse('2026-08-26T00:30:00.000Z'),
    }).verify('alice', envelope)
    const cloud: TargetKnowledgeCloudPort = {
      getEntitlement: vi.fn(async (): Promise<TargetCloudEntitlement> => ({
        tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true,
        killSwitchEnabled: false, version: 1, validUntil: null,
      })),
      getEmbeddingConsent: vi.fn(async (): Promise<TargetEmbeddingConsent> => ({
        processor: 'tokenhub', processingRegion: 'Guangzhou',
        model: 'kinfra-text-embedding-0.6b', dimensions: 1024,
        status: 'granted', retrievalByBase: [],
      })),
      setEmbeddingConsent: vi.fn(), capturePublishedSnapshot: vi.fn(), searchPublished: vi.fn(),
    }
    const app = await fixture({
      entitlement: verifiedMember,
      cloud,
      releaseAssessment: {
        betaEnabled: false,
        cloudEnabled: false,
        blockers: ['approved_evaluation_corpus'],
      },
    })
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    app.picks.push(await writeSource(app.rootDirectory, 'release-gated.txt', '发布门禁内容'))
    await app.service.importDocument(owner, base!.id)
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status).toBe('ready')
    await app.service.updateConversationSelection(owner, 'conversation_1', {
      knowledgeBaseIds: [base!.id], knowledgeMode: 'strict',
    })

    await expect(app.service.getEntitlement(owner)).resolves.toMatchObject({
      betaEnabled: false, cloudEnabled: false, knowledgeToolEnabled: false,
    })
    await expect(app.service.captureSearchSnapshot(owner, 'conversation_1')).resolves.toEqual({
      selected: false, knowledgeMode: 'strict',
    })
    await expect(app.service.setEmbeddingConsent(owner, 'granted'))
      .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(cloud.getEntitlement).toHaveBeenCalled()
    expect(cloud.setEmbeddingConsent).not.toHaveBeenCalled()
    await app.service.close()
  })

  it('blocks new Agent knowledge admission after kill switch while an authorized local snapshot finishes', async () => {
    const entitlement: KnowledgeEntitlementState = {
      tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: false,
      knowledgeToolEnabled: true, killSwitchEnabled: false,
    }
    let serverKillSwitchEnabled = false
    const cloud: TargetKnowledgeCloudPort = {
      getEntitlement: vi.fn(async (): Promise<TargetCloudEntitlement> => ({
        tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: false,
        killSwitchEnabled: serverKillSwitchEnabled, version: 1, validUntil: null,
      })),
      getEmbeddingConsent: vi.fn(), setEmbeddingConsent: vi.fn(),
      capturePublishedSnapshot: vi.fn(), searchPublished: vi.fn(),
    }
    const app = await fixture({ entitlement, cloud })
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    app.picks.push(await writeSource(app.rootDirectory, 'authorized.txt', '已授权本地快照可以完成'))
    await app.service.importDocument(owner, base!.id)
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status).toBe('ready')
    await app.service.updateConversationSelection(owner, 'conversation_1', {
      knowledgeBaseIds: [base!.id], knowledgeMode: 'strict',
    })

    const captured = await app.service.captureSearchSnapshot(owner, 'conversation_1')
    serverKillSwitchEnabled = true
    await expect(app.service.captureSearchSnapshot(owner, 'conversation_1')).resolves.toEqual({
      selected: false, knowledgeMode: 'strict',
    })
    serverKillSwitchEnabled = false
    Object.assign(entitlement, {
      betaEnabled: false, cloudEnabled: false,
      knowledgeToolEnabled: false, killSwitchEnabled: true,
    })

    await expect(app.service.captureSearchSnapshot(owner, 'conversation_1')).resolves.toEqual({
      selected: false, knowledgeMode: 'strict',
    })
    await expect(app.service.searchSnapshot(owner, captured, '本地快照')).resolves.toMatchObject({
      kind: 'results', results: [expect.objectContaining({ snippet: '已授权本地快照可以完成' })],
    })
    await expect(app.service.exportBase(owner, base!.id)).resolves.toBeUndefined()
    await app.service.recycleBase(owner, base!.id)
    await app.service.close()
  })

  it('denies cloud availability when the signed authorization revision changes during the server await', async () => {
    const authorization = revisionEntitlement({
      tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true,
      knowledgeToolEnabled: true, killSwitchEnabled: false,
    })
    const server = deferred<TargetCloudEntitlement>()
    const cloud: TargetKnowledgeCloudPort = {
      getEntitlement: vi.fn(() => server.promise),
      getEmbeddingConsent: vi.fn(), setEmbeddingConsent: vi.fn(),
      capturePublishedSnapshot: vi.fn(), searchPublished: vi.fn(),
    }
    const app = await fixture({ entitlementPort: authorization.port, cloud })
    const availability = app.service.getFeatureAvailability({ userId: 'alice' })
    await vi.waitFor(() => expect(cloud.getEntitlement).toHaveBeenCalledTimes(1))
    authorization.update({
      tier: 'member', status: 'active', betaEnabled: false, cloudEnabled: false,
      knowledgeToolEnabled: false, killSwitchEnabled: true,
    })
    server.resolve({
      tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true,
      killSwitchEnabled: false, version: 2, validUntil: '2026-09-26T00:00:00.000Z',
    })

    await expect(availability).resolves.toMatchObject({ cloud: { available: false } })
    await app.service.close()
  })

  it('refreshes local authority before the final server snapshot for cloud availability', async () => {
    const active: KnowledgeEntitlementState = {
      tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true,
      knowledgeToolEnabled: true, killSwitchEnabled: false,
    }
    const refreshStarted = deferred<void>()
    const releaseRefresh = deferred<boolean>()
    const entitlementPort: KnowledgeEntitlementPort = {
      getEntitlement: async () => active,
      getAuthorizationSnapshot: async () => ({ entitlement: active, revision: 1 }),
      isAuthorizationSnapshotCurrent: async () => {
        refreshStarted.resolve()
        return releaseRefresh.promise
      },
      isAuthorizationSnapshotCurrentNow: () => true,
    }
    let server: TargetCloudEntitlement = {
      tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true,
      killSwitchEnabled: false, version: 1, validUntil: '2026-09-26T00:00:00.000Z',
    }
    const cloud: TargetKnowledgeCloudPort = {
      getEntitlement: vi.fn(async () => ({ ...server })),
      getEmbeddingConsent: vi.fn(), setEmbeddingConsent: vi.fn(),
      capturePublishedSnapshot: vi.fn(), searchPublished: vi.fn(),
    }
    const app = await fixture({ entitlementPort, cloud })

    const availability = app.service.getFeatureAvailability({ userId: 'alice' })
    await refreshStarted.promise
    server = { ...server, killSwitchEnabled: true, version: 2 }
    releaseRefresh.resolve(true)

    await expect(availability).resolves.toMatchObject({ cloud: { available: false } })
    await app.service.close()
  })

  it('closes the synchronous token CAS after asynchronous authorization refresh', async () => {
    const active: KnowledgeEntitlementState = {
      tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true,
      knowledgeToolEnabled: true, killSwitchEnabled: false,
    }
    let revision = 1
    const entitlementPort = {
      getEntitlement: async () => active,
      getAuthorizationSnapshot: async () => ({ entitlement: active, revision }),
      isAuthorizationSnapshotCurrent: async () => {
        queueMicrotask(() => { revision += 1 })
        return true
      },
      isAuthorizationSnapshotCurrentNow: (_owner: { userId: string }, snapshot: { revision: number }) => (
        snapshot.revision === revision
      ),
    } as KnowledgeEntitlementPort & {
      isAuthorizationSnapshotCurrentNow(owner: { userId: string }, snapshot: { revision: number }): boolean
    }
    const cloud: TargetKnowledgeCloudPort = {
      getEntitlement: vi.fn(async (): Promise<TargetCloudEntitlement> => ({
        tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true,
        killSwitchEnabled: false, version: 1, validUntil: '2026-09-26T00:00:00.000Z',
      })),
      getEmbeddingConsent: vi.fn(), setEmbeddingConsent: vi.fn(),
      capturePublishedSnapshot: vi.fn(), searchPublished: vi.fn(),
    }
    const app = await fixture({ entitlementPort, cloud })

    await expect(app.service.getFeatureAvailability({ userId: 'alice' })).resolves.toMatchObject({
      cloud: { available: false },
    })
    await app.service.close()
  })

  it('denies new Agent admission when signed kill arrives during the legacy server await', async () => {
    const authorization = revisionEntitlement({
      tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: false,
      knowledgeToolEnabled: true, killSwitchEnabled: false,
    })
    const server = deferred<TargetCloudEntitlement>()
    const cloud: TargetKnowledgeCloudPort = {
      getEntitlement: vi.fn(() => server.promise),
      getEmbeddingConsent: vi.fn(), setEmbeddingConsent: vi.fn(),
      capturePublishedSnapshot: vi.fn(), searchPublished: vi.fn(),
    }
    const app = await fixture({ entitlementPort: authorization.port, cloud })
    const owner = { userId: 'alice' }
    const base = await app.service.createBase(owner, '本地 Agent 资料')
    app.picks.push(await writeSource(app.rootDirectory, 'agent-local.txt', '本地 Agent 快照'))
    await app.service.importDocument(owner, base.id)
    await expect.poll(async () => (await app.service.listDocuments(owner, base.id))[0]?.status).toBe('ready')
    await app.service.updateConversationSelection(owner, 'conversation_1', {
      knowledgeBaseIds: [base.id], knowledgeMode: 'strict',
    })
    const capture = app.service.captureSearchSnapshot(owner, 'conversation_1')
    await vi.waitFor(() => expect(cloud.getEntitlement).toHaveBeenCalledTimes(1))
    authorization.update({
      tier: 'member', status: 'active', betaEnabled: false, cloudEnabled: false,
      knowledgeToolEnabled: false, killSwitchEnabled: true,
    })
    server.resolve({
      tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: false,
      killSwitchEnabled: false, version: 2, validUntil: '2026-09-26T00:00:00.000Z',
    })

    await expect(capture).resolves.toEqual({ selected: false, knowledgeMode: 'strict' })
    await app.service.close()
  })

  it('refreshes local authority before the final server snapshot for local-only Agent admission', async () => {
    const active: KnowledgeEntitlementState = {
      tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: false,
      knowledgeToolEnabled: true, killSwitchEnabled: false,
    }
    const refreshStarted = deferred<void>()
    const releaseRefresh = deferred<boolean>()
    const entitlementPort: KnowledgeEntitlementPort = {
      getEntitlement: async () => active,
      getAuthorizationSnapshot: async () => ({ entitlement: active, revision: 1 }),
      isAuthorizationSnapshotCurrent: async () => {
        refreshStarted.resolve()
        return releaseRefresh.promise
      },
      isAuthorizationSnapshotCurrentNow: () => true,
    }
    let server: TargetCloudEntitlement = {
      tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: false,
      killSwitchEnabled: false, version: 1, validUntil: '2026-09-26T00:00:00.000Z',
    }
    const cloud: TargetKnowledgeCloudPort = {
      getEntitlement: vi.fn(async () => ({ ...server })),
      getEmbeddingConsent: vi.fn(), setEmbeddingConsent: vi.fn(),
      capturePublishedSnapshot: vi.fn(), searchPublished: vi.fn(),
    }
    const app = await fixture({ entitlementPort, cloud })
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    app.picks.push(await writeSource(app.rootDirectory, 'ordered-agent.txt', '有序本地 Agent'))
    await app.service.importDocument(owner, base!.id)
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status)
      .toBe('ready')
    await app.service.updateConversationSelection(owner, 'conversation_1', {
      knowledgeBaseIds: [base!.id], knowledgeMode: 'strict',
    })

    const capture = app.service.captureSearchSnapshot(owner, 'conversation_1')
    await refreshStarted.promise
    server = { ...server, killSwitchEnabled: true, version: 2 }
    releaseRefresh.resolve(true)

    await expect(capture).resolves.toEqual({ selected: false, knowledgeMode: 'strict' })
    await app.service.close()
  })

  it('discards a consent read when the final server snapshot advances version', async () => {
    const active: KnowledgeEntitlementState = {
      tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true,
      knowledgeToolEnabled: true, killSwitchEnabled: false,
    }
    const events: string[] = []
    const entitlementPort: KnowledgeEntitlementPort = {
      getEntitlement: async () => active,
      getAuthorizationSnapshot: async () => {
        events.push('local:snapshot')
        return { entitlement: active, revision: 1 }
      },
      isAuthorizationSnapshotCurrent: async () => {
        events.push('local:refresh')
        return true
      },
      isAuthorizationSnapshotCurrentNow: () => true,
    }
    let serverCalls = 0
    const cloud: TargetKnowledgeCloudPort = {
      getEntitlement: vi.fn(async (): Promise<TargetCloudEntitlement> => {
        serverCalls += 1
        events.push(`server:${serverCalls}`)
        return {
          tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true,
          killSwitchEnabled: false, version: serverCalls, validUntil: '2026-09-26T00:00:00.000Z',
        }
      }),
      getEmbeddingConsent: vi.fn(async (): Promise<TargetEmbeddingConsent> => {
        events.push('remote:consent-read')
        return {
          processor: 'tokenhub', processingRegion: 'Guangzhou',
          model: 'kinfra-text-embedding-0.6b', dimensions: 1024,
          status: 'granted', retrievalByBase: [],
        }
      }),
      setEmbeddingConsent: vi.fn(), capturePublishedSnapshot: vi.fn(), searchPublished: vi.fn(),
    }
    const app = await fixture({ entitlementPort, cloud })

    await expect(app.service.getConsent({ userId: 'alice' })).resolves.toMatchObject({
      embedding: { status: 'unknown', retrievalByBase: [] },
    })
    expect(events).toEqual([
      'local:snapshot', 'local:refresh', 'server:1', 'remote:consent-read',
      'local:refresh', 'server:2',
    ])
    await app.service.close()
  })

  it('rejects a consent mutation when the final server snapshot advances version', async () => {
    const active: KnowledgeEntitlementState = {
      tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true,
      knowledgeToolEnabled: true, killSwitchEnabled: false,
    }
    const entitlementPort = revisionEntitlement(active).port
    let serverCalls = 0
    const cloud: TargetKnowledgeCloudPort = {
      getEntitlement: vi.fn(async (): Promise<TargetCloudEntitlement> => ({
        tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true,
        killSwitchEnabled: false, version: ++serverCalls,
        validUntil: '2026-09-26T00:00:00.000Z',
      })),
      getEmbeddingConsent: vi.fn(),
      setEmbeddingConsent: vi.fn(async (): Promise<TargetEmbeddingConsent> => ({
        processor: 'tokenhub', processingRegion: 'Guangzhou',
        model: 'kinfra-text-embedding-0.6b', dimensions: 1024,
        status: 'granted', retrievalByBase: [],
      })),
      capturePublishedSnapshot: vi.fn(), searchPublished: vi.fn(),
    }
    const app = await fixture({ entitlementPort, cloud })

    await expect(app.service.setEmbeddingConsent({ userId: 'alice' }, 'granted'))
      .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    await app.service.close()
  })

  it('discards consent reads and mutations when signed kill arrives during their remote await', async () => {
    const active: KnowledgeEntitlementState = {
      tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true,
      knowledgeToolEnabled: true, killSwitchEnabled: false,
    }
    const killed: KnowledgeEntitlementState = {
      tier: 'member', status: 'active', betaEnabled: false, cloudEnabled: false,
      knowledgeToolEnabled: false, killSwitchEnabled: true,
    }
    const authorization = revisionEntitlement(active)
    const read = deferred<TargetEmbeddingConsent>()
    const write = deferred<TargetEmbeddingConsent>()
    const chatProvider = vi.fn(async () => ({ provider: 'openrouter' as const, status: 'unknown' as const }))
    const cloud: TargetKnowledgeCloudPort = {
      getEntitlement: vi.fn(async (): Promise<TargetCloudEntitlement> => ({
        tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true,
        killSwitchEnabled: false, version: 1, validUntil: '2026-09-26T00:00:00.000Z',
      })),
      getEmbeddingConsent: vi.fn(() => read.promise),
      setEmbeddingConsent: vi.fn(() => write.promise),
      capturePublishedSnapshot: vi.fn(), searchPublished: vi.fn(),
    }
    const app = await fixture({
      entitlementPort: authorization.port, cloud, getChatProviderConsent: chatProvider,
    })
    const owner = { userId: 'alice' }
    const consentRead = app.service.getConsent(owner)
    await vi.waitFor(() => expect(cloud.getEmbeddingConsent).toHaveBeenCalledTimes(1))
    authorization.update(killed)
    read.resolve({
      processor: 'tokenhub', processingRegion: 'Guangzhou',
      model: 'kinfra-text-embedding-0.6b', dimensions: 1024,
      status: 'granted', retrievalByBase: [{ knowledgeBaseId: 'kb_1', retrievalMode: 'hybrid' }],
    })
    await expect(consentRead).resolves.toMatchObject({
      embedding: { status: 'unknown', retrievalByBase: [] },
    })

    authorization.update(active)
    const consentWrite = app.service.setEmbeddingConsent(owner, 'granted')
    await vi.waitFor(() => expect(cloud.setEmbeddingConsent).toHaveBeenCalledTimes(1))
    const chatCallsBeforeKill = chatProvider.mock.calls.length
    authorization.update(killed)
    write.resolve({
      processor: 'tokenhub', processingRegion: 'Guangzhou',
      model: 'kinfra-text-embedding-0.6b', dimensions: 1024,
      status: 'granted', retrievalByBase: [],
    })
    await expect(consentWrite).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(chatProvider).toHaveBeenCalledTimes(chatCallsBeforeKill)
    await app.service.close()
  })

  it('does not start remote search after signed kill arrives during cloud snapshot capture', async () => {
    const authorization = revisionEntitlement({
      tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true,
      knowledgeToolEnabled: true, killSwitchEnabled: false,
    })
    const captured = deferred<Array<{ knowledgeBaseId: string; generationId: string }>>()
    const cloud: TargetKnowledgeCloudPort = {
      getEntitlement: vi.fn(async (): Promise<TargetCloudEntitlement> => ({
        tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true,
        killSwitchEnabled: false, version: 1, validUntil: '2026-09-26T00:00:00.000Z',
      })),
      getEmbeddingConsent: vi.fn(), setEmbeddingConsent: vi.fn(),
      capturePublishedSnapshot: vi.fn(() => captured.promise),
      searchPublished: vi.fn(async (): Promise<TargetCloudSearch> => ({
        mode: 'keyword_only', degradationReason: null, results: [],
      })),
    }
    const app = await fixture({ entitlementPort: authorization.port, cloud })
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    app.picks.push(await writeSource(app.rootDirectory, 'revision-race.txt', '远程快照竞态'))
    await app.service.importDocument(owner, base!.id)
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status).toBe('ready')
    await app.service.updateConversationSelection(owner, 'conversation_1', {
      knowledgeBaseIds: [base!.id], knowledgeMode: 'strict',
    })
    const opened = await openUserKnowledgeDatabase({
      rootDirectory: app.rootDirectory, userId: owner.userId, safeStorage: app.storage,
    })
    opened.database.prepare(`
      INSERT INTO cloud_sync_states(
        knowledge_base_id, mode, published_generation_id, epoch, updated_at
      ) VALUES (?, 'synced', 'generation_1', 1, 1)
    `).run(base!.id)
    opened.close()

    const search = app.service.search(owner, 'conversation_1', '远程快照')
    await vi.waitFor(() => expect(cloud.capturePublishedSnapshot).toHaveBeenCalledTimes(1))
    authorization.update({
      tier: 'member', status: 'active', betaEnabled: false, cloudEnabled: false,
      knowledgeToolEnabled: false, killSwitchEnabled: true,
    })
    captured.resolve([{ knowledgeBaseId: base!.id, generationId: 'generation_1' }])

    await expect(search).resolves.toEqual({ kind: 'results', results: [] })
    expect(cloud.searchPublished).not.toHaveBeenCalled()
    await app.service.close()
  })

  it.each([
    ['free tier', { tier: 'free' as const }],
    ['expired status', { status: 'expired' as const }],
    ['revoked-like unavailable status', { status: 'unavailable' as const }],
    ['beta disabled', { betaEnabled: false }],
    ['cloud disabled for synced scope', { cloudEnabled: false }],
    ['kill switch', { killSwitchEnabled: true }],
  ])('treats legacy server %s as an additional denial for synced search, consent, and Agent admission', async (_label, denial) => {
    const server = {
      tier: 'member' as const,
      status: 'active' as const,
      betaEnabled: true,
      cloudEnabled: true,
      killSwitchEnabled: false,
      version: 1,
      validUntil: null,
      ...denial,
    }
    const cloud: TargetKnowledgeCloudPort = {
      getEntitlement: vi.fn(async (): Promise<TargetCloudEntitlement> => ({ ...server })),
      getEmbeddingConsent: vi.fn(async (): Promise<TargetEmbeddingConsent> => ({
        processor: 'tokenhub', processingRegion: 'Guangzhou',
        model: 'kinfra-text-embedding-0.6b', dimensions: 1024,
        status: 'granted', retrievalByBase: [],
      })),
      setEmbeddingConsent: vi.fn(),
      capturePublishedSnapshot: vi.fn(async ({ knowledgeBaseIds }: Parameters<TargetKnowledgeCloudPort['capturePublishedSnapshot']>[0]) => knowledgeBaseIds.map(
        knowledgeBaseId => ({ knowledgeBaseId, generationId: 'generation_1' }),
      )),
      searchPublished: vi.fn(async (): Promise<TargetCloudSearch> => ({
        mode: 'keyword_only', degradationReason: null, results: [],
      })),
    }
    const app = await fixture({
      entitlement: {
        tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true,
        knowledgeToolEnabled: true, killSwitchEnabled: false,
      },
      cloud,
    })
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    app.picks.push(await writeSource(app.rootDirectory, 'server-denied.txt', '服务端拒绝后不可泄露'))
    await app.service.importDocument(owner, base!.id)
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status).toBe('ready')
    await app.service.updateConversationSelection(owner, 'conversation_1', {
      knowledgeBaseIds: [base!.id], knowledgeMode: 'strict',
    })
    const opened = await openUserKnowledgeDatabase({
      rootDirectory: app.rootDirectory, userId: owner.userId, safeStorage: app.storage,
    })
    opened.database.prepare(`
      INSERT INTO cloud_sync_states(
        knowledge_base_id, mode, published_generation_id, epoch, updated_at
      ) VALUES (?, 'synced', 'generation_1', 1, 1)
    `).run(base!.id)
    opened.close()

    await expect(app.service.captureSearchSnapshot(owner, 'conversation_1')).resolves.toEqual({
      selected: false, knowledgeMode: 'strict',
    })
    await expect(app.service.search(owner, 'conversation_1', '不可泄露')).resolves.toEqual({
      kind: 'results', results: [],
    })
    await expect(app.service.getConsent(owner)).resolves.toMatchObject({
      embedding: { status: 'unknown', retrievalByBase: [] },
    })
    expect(cloud.capturePublishedSnapshot).not.toHaveBeenCalled()
    expect(cloud.searchPublished).not.toHaveBeenCalled()
    expect(cloud.getEmbeddingConsent).not.toHaveBeenCalled()
    await app.service.close()
  })

  it('rechecks the server kill switch after remote search and snapshot awaits without synced-cache fallback', async () => {
    let killSwitchEnabled = false
    let killDuringCapture = false
    const cloud: TargetKnowledgeCloudPort = {
      getEntitlement: vi.fn(async (): Promise<TargetCloudEntitlement> => ({
        tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true,
        killSwitchEnabled, version: 1, validUntil: null,
      })),
      getEmbeddingConsent: vi.fn(), setEmbeddingConsent: vi.fn(),
      capturePublishedSnapshot: vi.fn(async ({ knowledgeBaseIds }: Parameters<TargetKnowledgeCloudPort['capturePublishedSnapshot']>[0]) => {
        if (killDuringCapture) killSwitchEnabled = true
        return knowledgeBaseIds.map(knowledgeBaseId => ({ knowledgeBaseId, generationId: 'generation_1' }))
      }),
      searchPublished: vi.fn(async () => {
        killSwitchEnabled = true
        throw new Error('remote closed after kill')
      }),
    }
    const app = await fixture({
      entitlement: {
        tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true,
        knowledgeToolEnabled: true, killSwitchEnabled: false,
      },
      cloud,
    })
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    app.picks.push(await writeSource(app.rootDirectory, 'late-kill.txt', '远程等待后不可回退同步缓存'))
    await app.service.importDocument(owner, base!.id)
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status).toBe('ready')
    await app.service.updateConversationSelection(owner, 'conversation_1', {
      knowledgeBaseIds: [base!.id], knowledgeMode: 'strict',
    })
    const opened = await openUserKnowledgeDatabase({
      rootDirectory: app.rootDirectory, userId: owner.userId, safeStorage: app.storage,
    })
    opened.database.prepare(`
      INSERT INTO cloud_sync_states(
        knowledge_base_id, mode, published_generation_id, epoch, updated_at
      ) VALUES (?, 'synced', 'generation_1', 1, 1)
    `).run(base!.id)
    opened.close()

    await expect(app.service.search(owner, 'conversation_1', '同步缓存')).resolves.toEqual({
      kind: 'results', results: [],
    })
    killSwitchEnabled = false
    killDuringCapture = true
    await expect(app.service.captureSearchSnapshot(owner, 'conversation_1')).resolves.toEqual({
      selected: false, knowledgeMode: 'strict',
    })
    await app.service.close()
  })

  it('does not use synced cached evidence after remote rejection when the final server version advances', async () => {
    let serverCalls = 0
    const cloud: TargetKnowledgeCloudPort = {
      getEntitlement: vi.fn(async (): Promise<TargetCloudEntitlement> => ({
        tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true,
        killSwitchEnabled: false, version: ++serverCalls === 3 ? 2 : 1,
        validUntil: '2026-09-26T00:00:00.000Z',
      })),
      getEmbeddingConsent: vi.fn(), setEmbeddingConsent: vi.fn(),
      capturePublishedSnapshot: vi.fn(async ({ knowledgeBaseIds }: Parameters<TargetKnowledgeCloudPort['capturePublishedSnapshot']>[0]) => knowledgeBaseIds.map(
        knowledgeBaseId => ({ knowledgeBaseId, generationId: 'generation_1' }),
      )),
      searchPublished: vi.fn(async () => { throw new Error('remote rejected') }),
    }
    const app = await fixture({
      entitlement: {
        tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true,
        knowledgeToolEnabled: true, killSwitchEnabled: false,
      },
      cloud,
    })
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    app.picks.push(await writeSource(app.rootDirectory, 'version-fallback.txt', '版本变化后不可回退缓存'))
    await app.service.importDocument(owner, base!.id)
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status)
      .toBe('ready')
    await app.service.updateConversationSelection(owner, 'conversation_1', {
      knowledgeBaseIds: [base!.id], knowledgeMode: 'strict',
    })
    const opened = await openUserKnowledgeDatabase({
      rootDirectory: app.rootDirectory, userId: owner.userId, safeStorage: app.storage,
    })
    opened.database.prepare(`
      INSERT INTO cloud_sync_states(
        knowledge_base_id, mode, published_generation_id, epoch, updated_at
      ) VALUES (?, 'synced', 'generation_1', 1, 1)
    `).run(base!.id)
    opened.close()

    await expect(app.service.search(owner, 'conversation_1', '不可回退缓存')).resolves.toEqual({
      kind: 'results', results: [],
    })
    expect(cloud.searchPublished).toHaveBeenCalledTimes(1)
    await app.service.close()
  })

  it('resolves an exact citation in Main and makes recycled sources unavailable', async () => {
    const app = await fixture()
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    app.picks.push(await writeSource(app.rootDirectory, 'preview.txt', '第一行受控预览文本'))
    const document = await app.service.importDocument(owner, base!.id)
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status).toBe('ready')
    await app.service.updateConversationSelection(owner, 'conversation_1', {
      knowledgeBaseIds: [base!.id], knowledgeMode: 'mixed',
    })
    const evidence = (await app.service.search(owner, 'conversation_1', '受控预览')).results[0]!
    const target = app.service as unknown as TargetSnapshotKnowledgeService

    await expect(target.previewCitation(owner, evidence.citation)).resolves.toEqual({
      status: 'available', kind: 'txt', excerpt: '第一行受控预览文本',
      startLine: 1, endLine: 1, startColumn: 0, endColumn: 9,
    })
    expect(evidence.citation.kind).toBe('txt')
    if (evidence.citation.kind !== 'txt') throw new Error('Expected TXT citation')
    await expect(target.previewCitation(owner, {
      ...evidence.citation,
      startColumn: 1,
    })).resolves.toEqual({ status: 'unavailable' })
    await app.service.recycleDocument(owner, document!.id)
    await expect(target.previewCitation(owner, evidence.citation)).resolves.toEqual({
      status: 'unavailable',
    })
    await app.service.close()
  })

  it('uses only authoritative synced selection for cloud hybrid search and keeps closed gates local', async () => {
    const localEntitlement: KnowledgeEntitlementState = {
      tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true,
      knowledgeToolEnabled: true, killSwitchEnabled: false,
    }
    const cloudGate = {
      tier: 'member' as const,
      status: 'active' as const,
      betaEnabled: true,
      cloudEnabled: true,
      killSwitchEnabled: false,
      version: 1,
      validUntil: null,
    }
    const remoteEvidence: KnowledgeSearchResult = {
      evidenceId: 'evidence_cloud', knowledgeBaseId: 'placeholder',
      documentId: 'document_cloud', versionId: 'version_cloud',
      snippet: 'Published cloud result.', score: 0.75,
      citation: {
        documentId: 'document_cloud', versionId: 'version_cloud',
        kind: 'markdown', nodeId: 'node_cloud',
      },
    }
    const cloud: TargetKnowledgeCloudPort = {
      getEntitlement: vi.fn(async (): Promise<TargetCloudEntitlement> => ({ ...cloudGate })),
      getEmbeddingConsent: vi.fn(async (): Promise<TargetEmbeddingConsent> => ({
        processor: 'tokenhub', processingRegion: 'Guangzhou',
        model: 'kinfra-text-embedding-0.6b', dimensions: 1024,
        status: 'granted',
        retrievalByBase: [{ knowledgeBaseId: 'placeholder', retrievalMode: 'hybrid' }],
      })),
      setEmbeddingConsent: vi.fn(async ({ status }: Parameters<TargetKnowledgeCloudPort['setEmbeddingConsent']>[0]): Promise<TargetEmbeddingConsent> => ({
        processor: 'tokenhub', processingRegion: 'Guangzhou',
        model: 'kinfra-text-embedding-0.6b', dimensions: 1024,
        status,
        retrievalByBase: [{
          knowledgeBaseId: 'placeholder',
          retrievalMode: status === 'granted' ? 'reindexing' : 'keyword_only',
        }],
      })),
      capturePublishedSnapshot: vi.fn(async ({ knowledgeBaseIds }: Parameters<TargetKnowledgeCloudPort['capturePublishedSnapshot']>[0]) => knowledgeBaseIds.map(
        knowledgeBaseId => ({ knowledgeBaseId, generationId: 'generation_published' }),
      )),
      searchPublished: vi.fn(async ({ generationSnapshot }: Parameters<TargetKnowledgeCloudPort['searchPublished']>[0]): Promise<TargetCloudSearch> => ({
        mode: 'hybrid', degradationReason: null,
        results: [{
          generationId: generationSnapshot[0]!.generationId,
          evidence: { ...remoteEvidence, knowledgeBaseId: generationSnapshot[0]!.knowledgeBaseId },
        }],
      })),
    }
    const app = await fixture({
      entitlement: localEntitlement,
      cloud,
    })
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    app.picks.push(await writeSource(app.rootDirectory, 'published.txt', '本地关键词回退内容'))
    await app.service.importDocument(owner, base!.id)
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status).toBe('ready')
    await app.service.updateConversationSelection(owner, 'conversation_1', {
      knowledgeBaseIds: [base!.id], knowledgeMode: 'strict',
    })
    await expect(app.service.search(owner, 'conversation_1', '本地关键词回退')).resolves.toMatchObject({
      kind: 'results', results: [expect.objectContaining({ knowledgeBaseId: base!.id })],
    })
    expect(cloud.getEntitlement).not.toHaveBeenCalled()
    expect(cloud.capturePublishedSnapshot).not.toHaveBeenCalled()
    const opened = await openUserKnowledgeDatabase({
      rootDirectory: app.rootDirectory, userId: owner.userId, safeStorage: app.storage,
    })
    opened.database.prepare(`
      INSERT INTO cloud_sync_states(
        knowledge_base_id, mode, published_generation_id, epoch, updated_at
      ) VALUES (?, 'synced', 'generation_published', 1, 1)
    `).run(base!.id)
    opened.close()

    await expect(app.service.listBases(owner)).resolves.toEqual([
      expect.objectContaining({ id: base!.id, kind: 'cloud' }),
    ])
    await expect(app.service.search(owner, 'conversation_1', '云端命中')).resolves.toEqual({
      kind: 'results',
      results: [expect.objectContaining({ evidenceId: 'evidence_cloud', knowledgeBaseId: base!.id })],
    })
    expect(cloud.capturePublishedSnapshot).toHaveBeenCalledWith({ knowledgeBaseIds: [base!.id] })
    expect(cloud.searchPublished).toHaveBeenCalledWith(expect.objectContaining({
      query: '云端命中', topK: 8,
      generationSnapshot: [{ knowledgeBaseId: base!.id, generationId: 'generation_published' }],
    }))

    const captured = await app.service.captureSearchSnapshot(owner, 'conversation_1')

    cloudGate.killSwitchEnabled = true
    Object.assign(localEntitlement, {
      betaEnabled: false, cloudEnabled: false,
      knowledgeToolEnabled: false, killSwitchEnabled: true,
    })
    await expect(app.service.searchSnapshot(owner, captured, '本地关键词回退')).resolves.toEqual({
      kind: 'results', results: [],
    })
    await expect(app.service.search(owner, 'conversation_1', '本地关键词回退')).resolves.toEqual({
      kind: 'results', results: [],
    })
    await expect(app.service.setEmbeddingConsent(owner, 'revoked'))
      .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(cloud.setEmbeddingConsent).not.toHaveBeenCalled()
    await expect(app.service.getConsent(owner)).resolves.toMatchObject({
      embedding: { status: 'unknown', retrievalByBase: [] },
    })
    expect(cloud.getEmbeddingConsent).not.toHaveBeenCalled()
    expect(cloud.searchPublished).toHaveBeenCalledTimes(1)
    await app.service.close()
  })

  it('keeps Main-owned TokenHub consent separate and generates the mutation request id', async () => {
    const cloud: TargetKnowledgeCloudPort = {
      getEntitlement: vi.fn(async (): Promise<TargetCloudEntitlement> => ({
        tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true,
        killSwitchEnabled: false, version: 1, validUntil: null,
      })),
      getEmbeddingConsent: vi.fn(async (): Promise<TargetEmbeddingConsent> => ({
        processor: 'tokenhub', processingRegion: 'Guangzhou',
        model: 'kinfra-text-embedding-0.6b', dimensions: 1024,
        status: 'denied',
        retrievalByBase: [{ knowledgeBaseId: 'kb_a', retrievalMode: 'keyword_only' }],
      })),
      setEmbeddingConsent: vi.fn(async ({ status }: Parameters<TargetKnowledgeCloudPort['setEmbeddingConsent']>[0]): Promise<TargetEmbeddingConsent> => ({
        processor: 'tokenhub', processingRegion: 'Guangzhou',
        model: 'kinfra-text-embedding-0.6b', dimensions: 1024,
        status,
        retrievalByBase: [{ knowledgeBaseId: 'kb_a', retrievalMode: 'reindexing' }],
      })),
      capturePublishedSnapshot: vi.fn(), searchPublished: vi.fn(),
    }
    const app = await fixture({
      cloud,
      entitlement: {
        tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true,
        knowledgeToolEnabled: true, killSwitchEnabled: false,
      },
    })
    const owner = { userId: 'alice' }

    await expect(app.service.getConsent(owner)).resolves.toMatchObject({
      chatProvider: { provider: 'openrouter' },
      embedding: {
        status: 'denied',
        retrievalByBase: [{ knowledgeBaseId: 'kb_a', retrievalMode: 'keyword_only' }],
      },
    })
    await expect(app.service.setEmbeddingConsent(owner, 'granted')).resolves.toMatchObject({
      embedding: { status: 'granted' },
    })
    expect(cloud.setEmbeddingConsent).toHaveBeenCalledWith({
      requestId: expect.stringMatching(/^[-\w]+$/), status: 'granted',
    })
    await app.service.close()
  })

  it('enables local storage only on the verified darwin arm64 runtime gate', async () => {
    const app = await fixture()
    const availability = await app.service.getFeatureAvailability({ userId: 'alice' })
    expect(availability).toEqual({
      local: { available: true, reasons: [] },
      cloud: { available: false, reasons: ['kill_switch_enabled'] },
    })
    expect(app.parsers).toHaveLength(1)
    expect(app.parsers[0]?.parseCalls).toBe(1)
    expect(app.parsers[0]?.lastTimeoutMs).toBe(5_000)
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

  it('keeps cloud availability fail-closed when any authoritative server gate is closed', async () => {
    const cloud: TargetKnowledgeCloudPort = {
      getEntitlement: vi.fn(async (): Promise<TargetCloudEntitlement> => ({
        tier: 'member', status: 'active', betaEnabled: false, cloudEnabled: true,
        killSwitchEnabled: false, version: 1, validUntil: null,
      })),
      getEmbeddingConsent: vi.fn(async (): Promise<TargetEmbeddingConsent> => ({
        processor: 'tokenhub', processingRegion: 'Guangzhou',
        model: 'kinfra-text-embedding-0.6b', dimensions: 1024,
        status: 'unknown', retrievalByBase: [],
      })),
      setEmbeddingConsent: vi.fn(), capturePublishedSnapshot: vi.fn(), searchPublished: vi.fn(),
    }
    const app = await fixture({ cloud })

    await expect(app.service.getFeatureAvailability({ userId: 'alice' })).resolves.toMatchObject({
      cloud: { available: false, reasons: ['kill_switch_enabled'] },
    })
    await app.service.close()
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
    const parserJobFailure = new InProcessParser()
    parserJobFailure.handler = async input => ({
      version: 1, type: 'error', jobId: input.jobId, code: 'PARSER_INTERNAL_ERROR',
    })
    const parserCannotParse = new KnowledgeService({
      ...common,
      createParser: async () => parserJobFailure,
    })
    await expect(parserCannotParse.getFeatureAvailability({ userId: 'alice' })).resolves.toMatchObject({
      local: { available: false, reasons: ['native_dependency_unavailable'] },
    })
    expect(parserJobFailure.terminated).toBe(true)
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
    expect(defaultBase).toMatchObject({ name: '我的知识库', kind: 'local', status: 'ready', searchable: false })
    await expect(app.service.createBase(owner, 'Second')).rejects.toMatchObject({ code: 'CONFLICT' })

    app.picks.push(await writeSource(app.rootDirectory, 'first.txt', '北京政务服务指南'))
    await expect(app.service.importDocument(owner, defaultBase!.id)).resolves.toMatchObject({
      name: 'first.txt', status: 'parsing', versionCount: 1,
    })
    await expect.poll(async () => (await app.service.listDocuments(owner, defaultBase!.id))[0]?.status).toBe('ready')
    await expect(app.service.listBases(owner)).resolves.toEqual([
      expect.objectContaining({ id: defaultBase!.id, searchable: true }),
    ])
    app.picks.push(await writeSource(app.rootDirectory, 'second.txt', '第二份文件'))
    await expect(app.service.importDocument(owner, defaultBase!.id)).rejects.toMatchObject({ code: 'CONFLICT' })
    await app.service.close()
  })

  it('admits only active libraries with a published ready document and removes the last recycled document', async () => {
    const app = await fixture()
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)

    await expect(app.service.updateConversationSelection(owner, 'conversation_1', {
      knowledgeBaseIds: [base!.id], knowledgeMode: 'strict',
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })

    app.picks.push(await writeSource(app.rootDirectory, 'published.txt', '可检索的已发布内容'))
    const imported = await app.service.importDocument(owner, base!.id)
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status).toBe('ready')
    await expect(app.service.updateConversationSelection(owner, 'conversation_1', {
      knowledgeBaseIds: [base!.id], knowledgeMode: 'strict',
    })).resolves.toEqual({ knowledgeBaseIds: [base!.id], knowledgeMode: 'strict' })

    await app.service.recycleDocument(owner, imported!.id)

    await expect(app.service.listBases(owner)).resolves.toEqual([
      expect.objectContaining({ id: base!.id, searchable: false }),
    ])
    await expect(app.service.getConversationSelection(owner, 'conversation_1')).resolves.toEqual({
      knowledgeBaseIds: [], knowledgeMode: 'strict',
    })
    await expect(app.service.updateConversationSelection(owner, 'conversation_1', {
      knowledgeBaseIds: [base!.id], knowledgeMode: 'mixed',
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await app.service.close()
  })

  it('removes read-only retained libraries from authoritative conversation scope and search', async () => {
    const app = await fixture()
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    app.picks.push(await writeSource(app.rootDirectory, 'retained.txt', '不可检索的只读保留资料'))
    await app.service.importDocument(owner, base!.id)
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status).toBe('ready')
    await app.service.updateConversationSelection(owner, 'conversation_1', {
      knowledgeBaseIds: [base!.id], knowledgeMode: 'strict',
    })
    const opened = await openUserKnowledgeDatabase({
      rootDirectory: app.rootDirectory, userId: owner.userId, safeStorage: app.storage,
    })
    opened.database.prepare("UPDATE knowledge_bases SET status = 'read_only' WHERE id = ?").run(base!.id)
    opened.close()

    await expect(app.service.listBases(owner)).resolves.toEqual([
      expect.objectContaining({ id: base!.id, status: 'read_only', searchable: false }),
    ])
    await expect(app.service.getConversationSelection(owner, 'conversation_1')).resolves.toEqual({
      knowledgeBaseIds: [], knowledgeMode: 'strict',
    })
    await expect(app.service.search(owner, 'conversation_1', '只读保留资料')).resolves.toEqual({
      kind: 'results', results: [],
    })
    await expect(app.service.updateConversationSelection(owner, 'conversation_1', {
      knowledgeBaseIds: [base!.id], knowledgeMode: 'mixed',
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await app.service.close()
  })

  it('removes expired entitlement from authoritative conversation scope', async () => {
    const entitlement: KnowledgeEntitlementState = {
      tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: false,
    }
    const app = await fixture({ entitlement })
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    app.picks.push(await writeSource(app.rootDirectory, 'expires.txt', '会员到期后停止检索'))
    await app.service.importDocument(owner, base!.id)
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status).toBe('ready')
    await app.service.updateConversationSelection(owner, 'conversation_1', {
      knowledgeBaseIds: [base!.id], knowledgeMode: 'strict',
    })
    entitlement.status = 'expired'

    await expect(app.service.getConversationSelection(owner, 'conversation_1')).resolves.toEqual({
      knowledgeBaseIds: [], knowledgeMode: 'strict',
    })
    await expect(app.service.search(owner, 'conversation_1', '停止检索')).resolves.toEqual({
      kind: 'results', results: [],
    })
    await expect(app.service.updateConversationSelection(owner, 'conversation_1', {
      knowledgeBaseIds: [base!.id], knowledgeMode: 'mixed',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await app.service.close()
  })

  it('rejects local creation when the current member entitlement is expired', async () => {
    const app = await fixture({
      entitlement: { tier: 'member', status: 'expired', betaEnabled: true, cloudEnabled: false },
    })
    const owner = { userId: 'alice' }
    await app.service.listBases(owner)
    await expect(app.service.createBase(owner, 'Second')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await app.service.close()
  })

  it('enforces current entitlement on create, import, and replace while retaining expired-user export and recycle', async () => {
    const entitlement: KnowledgeEntitlementState = {
      tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: false,
    }
    const app = await fixture({ entitlement })
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    app.picks.push(await writeSource(app.rootDirectory, 'retained.txt', '仍可导出的已就绪内容'))
    const imported = await app.service.importDocument(owner, base!.id)
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status).toBe('ready')
    entitlement.status = 'expired'

    await expect(app.service.createBase(owner, 'Forbidden')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(app.service.importDocument(owner, base!.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(app.service.replaceDocument(owner, imported!.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    app.exports.push(join(app.rootDirectory, 'retained.zip'))
    await expect(app.service.exportBase(owner, base!.id)).resolves.toBeUndefined()
    await expect(app.service.recycleDocument(owner, imported!.id)).resolves.toBeUndefined()
    await app.service.close()
  })

  it('durably applies one-base one-file downgrade selection and restores retained content after renewal', async () => {
    const membershipExpiresAt = '2026-08-26T00:00:00.000Z'
    let now = Date.parse('2026-08-26T00:00:00.000Z')
    const entitlement: KnowledgeEntitlementState = {
      tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: false,
      knowledgeToolEnabled: true, killSwitchEnabled: false,
      membershipExpiresAt,
      lifecycle: {
        phase: 'active', requiresSelection: false,
        downloadUntil: '2026-09-25T00:00:00.000Z',
        recycleUntil: '2026-10-25T00:00:00.000Z',
      },
    }
    const app = await fixture({ entitlement, now: () => now })
    const owner = { userId: 'alice' }
    const [firstBase] = await app.service.listBases(owner)
    const secondBase = await app.service.createBase(owner, '第二知识库')
    app.picks.push(await writeSource(app.rootDirectory, 'keep.txt', '保留文件可以检索'))
    const kept = await app.service.importDocument(owner, firstBase!.id)
    app.picks.push(await writeSource(app.rootDirectory, 'readonly.txt', '同库只读文件不能检索'))
    const sameBaseReadonly = await app.service.importDocument(owner, firstBase!.id)
    app.picks.push(await writeSource(app.rootDirectory, 'other.txt', '其他库只读文件不能检索'))
    await app.service.importDocument(owner, secondBase.id)
    await expect.poll(async () => (
      (await app.service.listDocuments(owner, firstBase!.id)).every(({ status }) => status === 'ready')
      && (await app.service.listDocuments(owner, secondBase.id)).every(({ status }) => status === 'ready')
    )).toBe(true)

    Object.assign(entitlement, {
      tier: 'free', status: 'expired', betaEnabled: false, cloudEnabled: false,
      knowledgeToolEnabled: false,
      lifecycle: {
        phase: 'download_window', requiresSelection: true,
        downloadUntil: '2026-09-25T00:00:00.000Z',
        recycleUntil: '2026-10-25T00:00:00.000Z',
      },
    })
    await expect(app.service.listBases(owner)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstBase!.id, status: 'read_only', searchable: false }),
      expect.objectContaining({ id: secondBase.id, status: 'read_only', searchable: false }),
    ]))

    await expect(app.service.chooseDowngradeSelection(owner, {
      knowledgeBaseId: firstBase!.id, documentId: kept!.id,
    })).resolves.toMatchObject({ lifecycle: { phase: 'download_window', requiresSelection: false } })
    await expect(app.service.listBases(owner)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstBase!.id, status: 'ready', searchable: true }),
      expect.objectContaining({ id: secondBase.id, status: 'read_only', searchable: false }),
    ]))
    await expect(app.service.listDocuments(owner, firstBase!.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: kept!.id, readOnly: false }),
      expect.objectContaining({ id: sameBaseReadonly!.id, readOnly: true }),
    ]))
    await expect(app.service.updateConversationSelection(owner, 'conversation_1', {
      knowledgeBaseIds: [firstBase!.id], knowledgeMode: 'strict',
    })).resolves.toMatchObject({ knowledgeBaseIds: [firstBase!.id] })
    await expect(app.service.search(owner, 'conversation_1', '保留文件')).resolves.toMatchObject({
      kind: 'results', results: [expect.objectContaining({ documentId: kept!.id })],
    })
    await expect(app.service.search(owner, 'conversation_1', '只读文件')).resolves.toEqual({
      kind: 'results', results: [],
    })

    await app.service.close()
    const restarted = app.createService()
    await expect(restarted.listBases(owner)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstBase!.id, status: 'ready', searchable: true }),
      expect.objectContaining({ id: secondBase.id, status: 'read_only', searchable: false }),
    ]))
    await expect(restarted.getEntitlement(owner)).resolves.toMatchObject({
      lifecycle: { phase: 'download_window', requiresSelection: false },
    })

    now += 1
    Object.assign(entitlement, {
      tier: 'member', status: 'active', betaEnabled: true,
      knowledgeToolEnabled: true,
      lifecycle: {
        phase: 'active', requiresSelection: false,
        downloadUntil: '2026-09-25T00:00:00.000Z',
        recycleUntil: '2026-10-25T00:00:00.000Z',
      },
    })
    await expect(restarted.listBases(owner)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstBase!.id, status: 'ready' }),
      expect.objectContaining({ id: secondBase.id, status: 'ready' }),
    ]))
    await expect(restarted.listDocuments(owner, firstBase!.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: kept!.id, readOnly: false }),
      expect.objectContaining({ id: sameBaseReadonly!.id, readOnly: false }),
    ]))
    await restarted.close()
  })

  it('makes downgrade selection idempotent and clears it when the retained item is recycled or purged', async () => {
    let now = Date.parse('2026-08-26T00:00:00.000Z')
    const entitlement: KnowledgeEntitlementState = {
      tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: false,
      knowledgeToolEnabled: true, killSwitchEnabled: false,
      membershipExpiresAt: '2026-08-26T00:00:00.000Z',
      lifecycle: {
        phase: 'active', requiresSelection: false,
        downloadUntil: '2026-09-25T00:00:00.000Z', recycleUntil: '2026-10-25T00:00:00.000Z',
      },
    }
    const app = await fixture({ entitlement, now: () => now })
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    app.picks.push(await writeSource(app.rootDirectory, 'retained.txt', '保留后删除'))
    const document = await app.service.importDocument(owner, base!.id)
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status).toBe('ready')
    Object.assign(entitlement, {
      tier: 'free', status: 'expired', betaEnabled: false, knowledgeToolEnabled: false,
      lifecycle: {
        phase: 'download_window', requiresSelection: true,
        downloadUntil: '2026-09-25T00:00:00.000Z', recycleUntil: '2026-10-25T00:00:00.000Z',
      },
    })
    await app.service.listBases(owner)
    const choice = { knowledgeBaseId: base!.id, documentId: document!.id }
    await expect(app.service.chooseDowngradeSelection(owner, choice)).resolves.toMatchObject({
      lifecycle: { requiresSelection: false },
    })
    await expect(app.service.chooseDowngradeSelection(owner, choice)).resolves.toMatchObject({
      lifecycle: { requiresSelection: false },
    })

    await app.service.recycleDocument(owner, document!.id)
    await expect(app.service.listBases(owner)).resolves.toEqual([
      expect.objectContaining({ id: base!.id, status: 'read_only', searchable: false }),
    ])
    await expect(app.service.chooseDowngradeSelection(owner, choice)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await app.service.purgeDocument(owner, document!.id)
    await expect(app.service.chooseDowngradeSelection(owner, choice)).rejects.toMatchObject({ code: 'NOT_FOUND' })

    Object.assign(entitlement, {
      tier: 'member', status: 'active', betaEnabled: true, knowledgeToolEnabled: true,
      membershipExpiresAt: '2026-09-26T00:00:00.000Z',
      lifecycle: {
        phase: 'active', requiresSelection: false,
        downloadUntil: '2026-10-26T00:00:00.000Z', recycleUntil: '2026-11-25T00:00:00.000Z',
      },
    })
    await expect(app.service.listBases(owner)).resolves.toEqual([
      expect.objectContaining({ id: base!.id, status: 'ready' }),
    ])
    app.picks.push(await writeSource(app.rootDirectory, 'renewed.txt', '续费后新增内容'))
    const renewedDocument = await app.service.importDocument(owner, base!.id)
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status).toBe('ready')

    now = Date.parse('2026-09-26T00:00:00.000Z')
    Object.assign(entitlement, {
      tier: 'free', status: 'expired', betaEnabled: false, knowledgeToolEnabled: false,
      lifecycle: {
        phase: 'download_window', requiresSelection: true,
        downloadUntil: '2026-10-26T00:00:00.000Z', recycleUntil: '2026-11-25T00:00:00.000Z',
      },
    })
    await expect(app.service.listBases(owner)).resolves.toEqual([
      expect.objectContaining({ id: base!.id, status: 'read_only', searchable: false }),
    ])
    await expect(app.service.chooseDowngradeSelection(owner, {
      knowledgeBaseId: base!.id, documentId: renewedDocument!.id,
    })).resolves.toMatchObject({ lifecycle: { requiresSelection: false } })
    await app.service.close()
  })

  it('rejects cloud-synced content as the retained local downgrade selection', async () => {
    const entitlement: KnowledgeEntitlementState = {
      tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true,
      knowledgeToolEnabled: true, killSwitchEnabled: false,
      membershipExpiresAt: '2026-08-26T00:00:00.000Z',
      lifecycle: {
        phase: 'active', requiresSelection: false,
        downloadUntil: '2026-09-25T00:00:00.000Z', recycleUntil: '2026-10-25T00:00:00.000Z',
      },
    }
    const app = await fixture({ entitlement, now: () => Date.parse('2026-08-26T00:00:00.000Z') })
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    app.picks.push(await writeSource(app.rootDirectory, 'cloud-only.txt', '云同步内容'))
    const document = await app.service.importDocument(owner, base!.id)
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status).toBe('ready')
    const opened = await openUserKnowledgeDatabase({
      rootDirectory: app.rootDirectory, userId: owner.userId, safeStorage: app.storage,
    })
    opened.database.prepare(`
      INSERT INTO cloud_sync_states(
        knowledge_base_id, mode, published_generation_id, epoch, updated_at
      ) VALUES (?, 'synced', 'published_generation', 1, 1)
    `).run(base!.id)
    opened.close()

    Object.assign(entitlement, {
      tier: 'free', status: 'expired', betaEnabled: false, cloudEnabled: false,
      knowledgeToolEnabled: false,
      lifecycle: {
        phase: 'download_window', requiresSelection: true,
        downloadUntil: '2026-09-25T00:00:00.000Z', recycleUntil: '2026-10-25T00:00:00.000Z',
      },
    })
    await app.service.listBases(owner)
    await expect(app.service.chooseDowngradeSelection(owner, {
      knowledgeBaseId: base!.id, documentId: document!.id,
    })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await app.service.close()
  })

  it('atomically cancels and drains late imports before publishing a downgrade selection', async () => {
    const entitlement: KnowledgeEntitlementState = {
      tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: false,
      knowledgeToolEnabled: true, killSwitchEnabled: false,
      membershipExpiresAt: '2026-08-26T00:00:00.000Z',
      lifecycle: {
        phase: 'active', requiresSelection: false,
        downloadUntil: '2026-09-25T00:00:00.000Z', recycleUntil: '2026-10-25T00:00:00.000Z',
      },
    }
    const app = await fixture({ entitlement, now: () => Date.parse('2026-08-26T00:00:00.000Z') })
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    app.picks.push(await writeSource(app.rootDirectory, 'retained-before-expiry.txt', '降级保留内容'))
    const retained = await app.service.importDocument(owner, base!.id)
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status).toBe('ready')

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
    app.picks.push(await writeSource(app.rootDirectory, 'late-after-expiry.txt', '晚到结果不得发布'))
    await app.service.importDocument(owner, base!.id)
    const input = await started.promise

    Object.assign(entitlement, {
      tier: 'free', status: 'expired', betaEnabled: false, knowledgeToolEnabled: false,
      lifecycle: {
        phase: 'download_window', requiresSelection: true,
        downloadUntil: '2026-09-25T00:00:00.000Z', recycleUntil: '2026-10-25T00:00:00.000Z',
      },
    })
    await app.service.listBases(owner)
    await app.service.chooseDowngradeSelection(owner, {
      knowledgeBaseId: base!.id, documentId: retained!.id,
    })

    const abortedBeforeSelectionReturned = input.signal?.aborted === true
    if (!abortedBeforeSelectionReturned) {
      finish.resolve(parsedText(input.jobId, '晚到结果不得发布'))
    }
    await expect.poll(() => drained).toBe(true)
    expect(abortedBeforeSelectionReturned).toBe(true)
    await expect(app.service.listDocuments(owner, base!.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: retained!.id, readOnly: false }),
      expect.objectContaining({ name: 'late-after-expiry.txt', status: 'failed', readOnly: true }),
    ]))
    await app.service.close()
  })

  it('fails closed retained paid data into a durable exact selection without blocking a never-member 1/1 library', async () => {
    const entitlement: KnowledgeEntitlementState = {
      tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: false,
      knowledgeToolEnabled: true, killSwitchEnabled: false,
    }
    const app = await fixture({ entitlement })
    const owner = { userId: 'alice' }
    const [firstBase] = await app.service.listBases(owner)
    app.picks.push(await writeSource(app.rootDirectory, 'paid-first.txt', '第一个付费文件'))
    const firstDocument = await app.service.importDocument(owner, firstBase!.id)
    const secondBase = await app.service.createBase(owner, '第二个付费库')
    app.picks.push(await writeSource(app.rootDirectory, 'paid-second.txt', '第二个付费文件'))
    await app.service.importDocument(owner, secondBase.id)
    await expect.poll(async () => (await app.service.listBases(owner)).every(base => base.searchable)).toBe(true)
    await app.service.updateConversationSelection(owner, 'conversation_1', {
      knowledgeBaseIds: [firstBase!.id, secondBase.id], knowledgeMode: 'strict',
    })

    Object.assign(entitlement, {
      tier: 'free', status: 'active', betaEnabled: false, cloudEnabled: false,
      knowledgeToolEnabled: false, killSwitchEnabled: true,
    })
    await expect(app.service.listBases(owner)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstBase!.id, status: 'read_only', searchable: false }),
      expect.objectContaining({ id: secondBase.id, status: 'read_only', searchable: false }),
    ]))
    await expect(app.service.getEntitlement(owner)).resolves.toMatchObject({
      lifecycle: { phase: 'active', requiresSelection: true },
    })
    await expect(app.service.getConversationSelection(owner, 'conversation_1')).resolves.toEqual({
      knowledgeBaseIds: [], knowledgeMode: 'strict',
    })
    await expect(app.service.search(owner, 'conversation_1', '付费文件')).resolves.toEqual({
      kind: 'results', results: [],
    })
    await expect(app.service.replaceDocument(owner, firstDocument!.id))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })

    await expect(app.service.chooseDowngradeSelection(owner, {
      knowledgeBaseId: firstBase!.id, documentId: firstDocument!.id,
    })).resolves.toMatchObject({ lifecycle: { phase: 'active', requiresSelection: false } })
    await app.service.updateConversationSelection(owner, 'conversation_1', {
      knowledgeBaseIds: [firstBase!.id], knowledgeMode: 'strict',
    })
    await expect(app.service.search(owner, 'conversation_1', '第一个付费文件')).resolves.toMatchObject({
      kind: 'results', results: [expect.objectContaining({ documentId: firstDocument!.id })],
    })
    await app.service.close()
    const restarted = app.createService()
    await expect(restarted.listBases(owner)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstBase!.id, status: 'ready', searchable: true }),
      expect.objectContaining({ id: secondBase.id, status: 'read_only', searchable: false }),
    ]))
    await restarted.close()

    const neverMember = await fixture({ entitlement: {
      tier: 'free', status: 'active', betaEnabled: false, cloudEnabled: false,
      knowledgeToolEnabled: false, killSwitchEnabled: true,
    } })
    const [freeBase] = await neverMember.service.listBases(owner)
    neverMember.picks.push(await writeSource(neverMember.rootDirectory, 'free.txt', '免费文件'))
    const freeDocument = await neverMember.service.importDocument(owner, freeBase!.id)
    await expect.poll(async () => (await neverMember.service.listDocuments(owner, freeBase!.id))[0]?.status)
      .toBe('ready')
    neverMember.picks.push(await writeSource(neverMember.rootDirectory, 'free-replaced.txt', '免费替换'))
    await expect(neverMember.service.replaceDocument(owner, freeDocument!.id)).resolves.toBeDefined()
    await neverMember.service.close()
  })

  it('uses one serialized authoritative entitlement decision when creating a base', async () => {
    const getEntitlement = vi.fn(async (): Promise<KnowledgeEntitlementState> => ({
      tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: false,
    }))
    const app = await fixture({ entitlementPort: { getEntitlement } })
    await expect(app.service.createBase({ userId: 'alice' }, '单次判定')).resolves.toBeDefined()
    expect(getEntitlement).toHaveBeenCalledTimes(1)
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
    app.picks.push(await writeSource(app.rootDirectory, 'owned.txt', '归属校验内容'))
    await app.service.importDocument(alice, base!.id)
    await expect.poll(async () => (await app.service.listDocuments(alice, base!.id))[0]?.status).toBe('ready')
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

  it('revokes authority and drains snapshot creation before recycling without accepting its object', async () => {
    const snapshotStarted = deferred<void>()
    const releaseSnapshot = deferred<void>()
    const app = await fixture({
      createObjectSnapshot: async input => {
        snapshotStarted.resolve()
        await releaseSnapshot.promise
        return createEncryptedObjectSnapshot(input)
      },
    })
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    app.picks.push(await writeSource(app.rootDirectory, 'snapshot-recycle.txt', '快照期间回收'))
    const importing = app.service.importDocument(owner, base!.id)
    await snapshotStarted.promise
    const [pending] = await app.service.listDocuments(owner, base!.id)

    let lifecycleFinished = false
    const recycling = app.service.recycleDocument(owner, pending!.id).then(() => { lifecycleFinished = true })
    await new Promise(resolve => setImmediate(resolve))
    const finishedBeforeSnapshot = lifecycleFinished
    const during = await openUserKnowledgeDatabase({
      rootDirectory: app.rootDirectory, userId: owner.userId, safeStorage: app.storage,
    })
    const authorityDuringDrain = during.database.prepare(
      'SELECT count(*) AS count FROM document_import_heads WHERE document_id = ?',
    ).get(pending!.id)
    const jobDuringDrain = during.database.prepare(`
      SELECT jobs.status FROM jobs JOIN local_import_jobs ON local_import_jobs.job_id = jobs.id
      WHERE local_import_jobs.document_id = ?
    `).get(pending!.id)
    during.close()
    releaseSnapshot.resolve()

    const importOutcome = await importing.then(value => ({ value }), error => ({ error }))
    await recycling
    await app.service.close()

    expect(finishedBeforeSnapshot).toBe(false)
    expect(authorityDuringDrain).toEqual({ count: 0 })
    expect(jobDuringDrain).toEqual({ status: 'cancelled' })
    expect(importOutcome).toMatchObject({ error: { code: 'CANCELLED' } })
    const inspected = await openUserKnowledgeDatabase({
      rootDirectory: app.rootDirectory, userId: owner.userId, safeStorage: app.storage,
    })
    expect(inspected.database.prepare('SELECT count(*) AS count FROM source_objects').get()).toEqual({ count: 0 })
    expect(inspected.database.prepare("SELECT count(*) AS count FROM jobs WHERE status = 'pending'").get())
      .toEqual({ count: 0 })
    inspected.close()
    expect(() => findFileEnding(app.rootDirectory, '.afobj')).toThrow('.afobj not found')
  })

  it('revokes authority and drains snapshot creation before purge removes the import graph', async () => {
    const snapshotStarted = deferred<void>()
    const releaseSnapshot = deferred<void>()
    const app = await fixture({
      createObjectSnapshot: async input => {
        snapshotStarted.resolve()
        await releaseSnapshot.promise
        return createEncryptedObjectSnapshot(input)
      },
    })
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    app.picks.push(await writeSource(app.rootDirectory, 'snapshot-purge.txt', '快照期间永久删除'))
    const importing = app.service.importDocument(owner, base!.id)
    await snapshotStarted.promise
    const [pending] = await app.service.listDocuments(owner, base!.id)

    let lifecycleFinished = false
    const purging = app.service.purgeDocument(owner, pending!.id).then(() => { lifecycleFinished = true })
    await new Promise(resolve => setImmediate(resolve))
    const finishedBeforeSnapshot = lifecycleFinished
    const during = await openUserKnowledgeDatabase({
      rootDirectory: app.rootDirectory, userId: owner.userId, safeStorage: app.storage,
    })
    const authorityDuringDrain = during.database.prepare(
      'SELECT count(*) AS count FROM document_import_heads WHERE document_id = ?',
    ).get(pending!.id)
    during.close()
    releaseSnapshot.resolve()

    const importOutcome = await importing.then(value => ({ value }), error => ({ error }))
    await purging
    await app.service.close()

    expect(finishedBeforeSnapshot).toBe(false)
    expect(authorityDuringDrain).toEqual({ count: 0 })
    expect(importOutcome).toMatchObject({ error: { code: 'CANCELLED' } })
    const inspected = await openUserKnowledgeDatabase({
      rootDirectory: app.rootDirectory, userId: owner.userId, safeStorage: app.storage,
    })
    for (const table of ['source_objects', 'local_import_jobs', 'jobs']) {
      expect(inspected.database.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 })
    }
    inspected.close()
    expect(() => findFileEnding(app.rootDirectory, '.afobj')).toThrow('.afobj not found')
  })

  it.each([
    { lifecycle: 'recycle', failureStep: 'unlink', recovery: 'retry' },
    { lifecycle: 'purge', failureStep: 'unlink', recovery: 'retry' },
    { lifecycle: 'recycle', failureStep: 'directory-fsync', recovery: 'reopen' },
    { lifecycle: 'purge', failureStep: 'directory-fsync', recovery: 'reopen' },
  ] as const)(
    'journals and retries a CAS-rejected snapshot after $failureStep failure during $lifecycle',
    async ({ lifecycle, failureStep, recovery }) => {
      const snapshotStarted = deferred<void>()
      const releaseSnapshot = deferred<void>()
      const cleanupFailure = Object.assign(new Error(`injected ${failureStep} failure`), { code: 'EIO' })
      let cleanupAttempts = 0
      const app = await fixture({
        createObjectSnapshot: async input => {
          snapshotStarted.resolve()
          await releaseSnapshot.promise
          return createEncryptedObjectSnapshot(input)
        },
        removeKnowledgeObjectDurably: async path => {
          cleanupAttempts += 1
          if (cleanupAttempts === 1) {
            if (failureStep === 'directory-fsync') await unlink(path)
            throw cleanupFailure
          }
          await removeFileDurably(path)
        },
      })
      const owner = { userId: 'alice' }
      const [base] = await app.service.listBases(owner)
      app.picks.push(await writeSource(
        app.rootDirectory,
        `journal-${lifecycle}-${failureStep}.txt`,
        `journal ${lifecycle} ${failureStep}`,
      ))
      const importing = app.service.importDocument(owner, base!.id)
      await snapshotStarted.promise
      const [pending] = await app.service.listDocuments(owner, base!.id)
      const firstLifecycle = (lifecycle === 'recycle'
        ? app.service.recycleDocument(owner, pending!.id)
        : app.service.purgeDocument(owner, pending!.id)
      )
      releaseSnapshot.resolve()

      const [importOutcome, lifecycleOutcome] = await Promise.all([
        importing.then(value => ({ value }), error => ({ error })),
        firstLifecycle.then(value => ({ value }), error => ({ error })),
      ])
      expect(importOutcome).toMatchObject({ error: cleanupFailure })
      expect(lifecycleOutcome).toMatchObject({ error: cleanupFailure })
      expect(cleanupAttempts).toBe(1)

      const journaled = await openUserKnowledgeDatabase({
        rootDirectory: app.rootDirectory, userId: owner.userId, safeStorage: app.storage,
      })
      const localJob = journaled.database.prepare(`
        SELECT job_id AS jobId, document_id AS documentId FROM local_import_jobs
      `).get() as { jobId: string; documentId: string }
      const orphan = journaled.database.prepare(`
        SELECT relative_name AS relativeName, job_id AS jobId, document_id AS documentId
        FROM orphan_object_cleanups
      `).get()
      expect(orphan).toEqual({
        relativeName: expect.stringMatching(/^[0-9a-f-]+\.afobj$/),
        jobId: localJob.jobId,
        documentId: pending!.id,
      })
      expect(journaled.database.prepare('SELECT count(*) AS count FROM source_objects').get())
        .toEqual({ count: 0 })
      expect(journaled.database.prepare("SELECT count(*) AS count FROM jobs WHERE status = 'pending'").get())
        .toEqual({ count: 0 })
      const objectPath = join(dirname(journaled.databasePath), 'objects', (orphan as { relativeName: string }).relativeName)
      if (failureStep === 'unlink') await expect(readFile(objectPath)).resolves.toBeInstanceOf(Buffer)
      else await expect(readFile(objectPath)).rejects.toMatchObject({ code: 'ENOENT' })
      journaled.close()

      let recovered = app.service
      if (recovery === 'retry') {
        await (lifecycle === 'recycle'
          ? recovered.recycleDocument(owner, pending!.id)
          : recovered.purgeDocument(owner, pending!.id))
      } else {
        await app.service.close()
        recovered = app.createService()
        await recovered.listBases(owner)
      }
      await recovered.close()

      const inspected = await openUserKnowledgeDatabase({
        rootDirectory: app.rootDirectory, userId: owner.userId, safeStorage: app.storage,
      })
      expect(inspected.database.prepare('SELECT count(*) AS count FROM orphan_object_cleanups').get())
        .toEqual({ count: 0 })
      expect(inspected.database.prepare('SELECT count(*) AS count FROM source_objects').get()).toEqual({ count: 0 })
      expect(inspected.database.prepare("SELECT count(*) AS count FROM jobs WHERE status = 'pending'").get())
        .toEqual({ count: 0 })
      inspected.close()
      await expect(readFile(objectPath)).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it('does not acknowledge a post-rename snapshot sync failure and removes its unmanaged object', async () => {
    const syncFailure = Object.assign(new Error('injected object directory sync failure'), { code: 'EIO' })
    const app = await fixture({
      createObjectSnapshot: async input => {
        await createEncryptedObjectSnapshot(input)
        throw syncFailure
      },
    })
    const owner = { userId: 'alice' }
    const [base] = await app.service.listBases(owner)
    app.picks.push(await writeSource(app.rootDirectory, 'snapshot-sync-failure.txt', '不得确认的快照'))

    await expect(app.service.importDocument(owner, base!.id)).rejects.toBe(syncFailure)
    expect((await app.service.listDocuments(owner, base!.id))[0]).toMatchObject({ status: 'failed' })
    await app.service.close()

    const inspected = await openUserKnowledgeDatabase({
      rootDirectory: app.rootDirectory, userId: owner.userId, safeStorage: app.storage,
    })
    expect(inspected.database.prepare('SELECT count(*) AS count FROM source_objects').get()).toEqual({ count: 0 })
    expect(inspected.database.prepare("SELECT count(*) AS count FROM jobs WHERE status = 'pending'").get())
      .toEqual({ count: 0 })
    inspected.close()
    expect(() => findFileEnding(app.rootDirectory, '.afobj')).toThrow('.afobj not found')
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

  it.each(['recycle', 'purge'] as const)(
    'drains a superseded active parser before %s lifecycle completion',
    async (lifecycle) => {
      const app = await fixture()
      const owner = { userId: 'alice' }
      const [base] = await app.service.listBases(owner)
      app.picks.push(await writeSource(app.rootDirectory, 'superseded-original.txt', '初始版本'))
      const imported = await app.service.importDocument(owner, base!.id)
      await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status).toBe('ready')

      const oldStarted = deferred<Parameters<KnowledgeParserPort['parse']>[0]>()
      const oldFinish = deferred<ParserResponse>()
      let replacementNumber = 0
      app.parsers[0]!.handler = async input => {
        replacementNumber += 1
        if (replacementNumber === 1) {
          oldStarted.resolve(input)
          return oldFinish.promise
        }
        return parsedText(input.jobId, '最新替换内容')
      }
      app.picks.push(await writeSource(app.rootDirectory, 'superseded-old.txt', '较旧替换内容'))
      await app.service.replaceDocument(owner, imported!.id)
      const oldInput = await oldStarted.promise
      app.picks.push(await writeSource(app.rootDirectory, 'superseded-new.txt', '最新替换内容'))
      await app.service.replaceDocument(owner, imported!.id)
      await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.name)
        .toBe('superseded-new.txt')
      expect(oldInput.signal?.aborted).toBe(true)

      const operation = (lifecycle === 'recycle'
        ? app.service.recycleDocument(owner, imported!.id)
        : app.service.purgeDocument(owner, imported!.id)
      )
      const finishedBeforeSupersededParser = await Promise.race([
        operation.then(() => true),
        new Promise<false>(resolve => setTimeout(() => resolve(false), 250)),
      ])
      oldFinish.resolve(parsedText(oldInput.jobId, '不得发布的较旧替换内容'))
      await operation

      expect(finishedBeforeSupersededParser).toBe(false)
      if (lifecycle === 'recycle') {
        expect((await app.service.listDocuments(owner, base!.id))[0]?.status).toBe('deleted')
      } else {
        expect(await app.service.listDocuments(owner, base!.id)).toEqual([])
      }
      await app.service.close()
    },
  )

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
    await expect.poll(async () => (await app.service.listDocuments(owner, base!.id))[0]?.status).toBe('ready')
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

      await app.service.recycleDocument(owner, imported!.id)
      await expect(app.service.purgeDocument(owner, imported!.id)).rejects.toThrow(`injected ${failureStep} failure`)
      await app.service.close()

      const reopened = app.createService()
      await reopened.listBases(owner)
      expect(await reopened.listDocuments(owner, base!.id)).toEqual([])
      await expect(readFile(objectPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(databaseKeyPath, 'utf8')).not.toBe(keyBefore)
      await reopened.close()

      const inspected = await openUserKnowledgeDatabase({
        rootDirectory: app.rootDirectory, userId: owner.userId, safeStorage: app.storage,
      })
      for (const table of ['purge_operations', 'source_objects', 'local_import_jobs', 'jobs', 'tombstones']) {
        expect(inspected.database.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 })
      }
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
