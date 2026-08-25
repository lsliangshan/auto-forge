import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type {
  ByokUsageEvent,
  ChatBlock,
  PulledMutation,
  SyncMutation,
  SyncMutationResult,
} from '@autoforge/shared'

type FixtureUser = 'alice' | 'bob'

interface StoredConversation {
  id: string
  title: string
  revision: number
  deleted: boolean
}

interface StoredPreferences {
  timezone: string
  displayCurrency: 'CNY' | 'USD'
  revision: number
  updatedAt: string
}

interface StoredMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  blocks: ChatBlock[]
  executionId?: string
  createdAt: string
}

interface StoredReceipt {
  requestHash: string
  result: SyncMutationResult
}

interface UserState {
  online: boolean
  failAfterApply: boolean
  failAfterApplyAndPurge: boolean
  events: PulledMutation[]
  receipts: Map<string, StoredReceipt>
  conversations: Map<string, StoredConversation>
  messages: Map<string, StoredMessage>
  consents: Set<string>
  usage: Map<string, ByokUsageEvent>
  preferences: StoredPreferences
  importedBatches: Map<string, string>
  duplicateMutationCount: number
  pullPageSizes: number[]
  purgedCreateIdentity?: Pick<
    Extract<SyncMutation, { kind: 'conversation.create' }>,
    'id' | 'kind' | 'entityId' | 'baseRevision' | 'occurredAt'
  >
}

export interface CloudUserDataFixtureSnapshot {
  conversations: StoredConversation[]
  consentCount: number
  importedBatchCount: number
  duplicateMutationCount: number
  pullPageSizes: number[]
  compactedConversationEventCount: number
  retainedConversationPayloadCount: number
}

export interface CloudUserDataFixture {
  readonly origin: string
  reset(): Promise<void>
  close(): Promise<void>
  setOnline(user: FixtureUser, online: boolean): Promise<void>
  failAfterApplyOnce(user: FixtureUser): Promise<void>
  failAfterApplyAndPurgeOnce(user: FixtureUser): Promise<void>
  retryPurgedMutationWithChangedContent(user: FixtureUser): Promise<SyncMutationResult>
  seedConversations(user: FixtureUser, count: number, titlePrefix: string): Promise<void>
  seedByokUsage(user: FixtureUser): Promise<void>
  snapshot(user: FixtureUser): Promise<CloudUserDataFixtureSnapshot>
}

function initialUserState(): UserState {
  return {
    online: true,
    failAfterApply: false,
    failAfterApplyAndPurge: false,
    events: [],
    receipts: new Map(),
    conversations: new Map(),
    messages: new Map(),
    consents: new Set(),
    usage: new Map(),
    preferences: {
      timezone: 'Asia/Shanghai',
      displayCurrency: 'CNY',
      revision: 0,
      updatedAt: '2026-08-25T00:00:00.000Z',
    },
    importedBatches: new Map(),
    duplicateMutationCount: 0,
    pullPageSizes: [],
  }
}

function fixtureUser(value: string | undefined): FixtureUser | undefined {
  return value === 'alice' || value === 'bob' ? value : undefined
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (error) { reject(error) }
    })
    request.on('error', reject)
  })
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

function cursor(offset: number): string {
  return `cursor_${String(offset).padStart(16, '0')}`
}

function cursorOffset(value: unknown): number | undefined {
  if (value === undefined) return 0
  if (typeof value !== 'string' || !/^cursor_\d{16}$/u.test(value)) return undefined
  return Number(value.slice('cursor_'.length))
}

function receivedAt(sequence: number): string {
  return new Date(Date.UTC(2026, 7, 25, 0, 0, 0, sequence)).toISOString()
}

function requestHash(value: unknown): string {
  const canonicalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonicalize)
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item)
          .filter(([, child]) => child !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonicalize(child)]),
      )
    }
    return item
  }
  return createHash('md5').update(JSON.stringify(canonicalize(value))).digest('hex')
}

function importRequestHash(input: Record<string, unknown>): string {
  return requestHash({
    protocolVersion: input.protocolVersion,
    deviceId: input.deviceId,
    batchId: input.batchId,
    includeUnowned: input.includeUnowned,
    conversations: input.conversations,
    messages: input.messages,
    cloudSyncConsent: input.cloudSyncConsent,
    unownedImportConsent: input.unownedImportConsent ?? null,
  })
}

function importMutationId(
  batchId: string,
  kind: 'conversation' | 'message',
  entityId: string,
): string {
  const digest = createHash('md5').update(`${batchId}:${kind}:${entityId}`).digest('hex')
  return `legacy-${kind}:${digest}`
}

function pulled(
  mutation: SyncMutation,
  resultRevision: number,
  sequence: number,
): PulledMutation {
  const { occurredAt: _occurredAt, ...wireMutation } = mutation
  void _occurredAt
  return {
    ...wireMutation,
    resultRevision,
    receivedAt: receivedAt(sequence),
  } as PulledMutation
}

function appendEvent(state: UserState, mutation: SyncMutation, resultRevision: number): void {
  state.events.push(pulled(mutation, resultRevision, state.events.length + 1))
}

function eventConversationId(event: PulledMutation): string | undefined {
  if (event.kind.startsWith('conversation.')) return event.entityId
  if (event.kind !== 'message.append') return undefined
  return 'compacted' in event ? event.conversationId : event.payload.conversationId
}

function purgeConversation(state: UserState, conversationId: string): void {
  state.events = state.events.map((event): PulledMutation => {
    if (eventConversationId(event) !== conversationId) return event
    return {
      id: event.id,
      kind: event.kind as 'conversation.create',
      entityId: event.entityId,
      baseRevision: event.baseRevision,
      resultRevision: event.resultRevision,
      compacted: true,
      receivedAt: event.receivedAt,
      ...(event.kind === 'message.append' ? { kind: event.kind, conversationId } : {}),
    } as PulledMutation
  })
  for (const [messageId, message] of state.messages) {
    if (message.conversationId === conversationId) state.messages.delete(messageId)
  }
  state.conversations.delete(conversationId)
}

function deleteAndPurgeAppliedCreate(
  state: UserState,
  mutation: Extract<SyncMutation, { kind: 'conversation.create' }>,
): void {
  const conversation = state.conversations.get(mutation.entityId)
  if (!conversation) throw new Error('Applied conversation was unavailable for purge')
  const deletion: SyncMutation = {
    id: `purge_delete_${mutation.id}`,
    kind: 'conversation.delete',
    entityId: mutation.entityId,
    baseRevision: conversation.revision,
    payload: {},
    occurredAt: '2026-10-25T00:00:00.000Z',
  }
  const deletionResult = applyMutation(state, deletion)
  if (deletionResult.status !== 'applied') throw new Error('Fixture purge delete did not apply')
  const { payload: _payload, ...identity } = mutation
  void _payload
  state.purgedCreateIdentity = identity
  purgeConversation(state, mutation.entityId)
}

function applyMutation(state: UserState, mutation: SyncMutation): SyncMutationResult {
  const existingReceipt = state.receipts.get(mutation.id)
  if (existingReceipt) {
    if (existingReceipt.requestHash === requestHash(mutation)) {
      state.duplicateMutationCount += 1
      return { ...existingReceipt.result, status: 'duplicate' }
    }
    return { id: mutation.id, status: 'rejected', errorCode: 'INVALID_INPUT' }
  }

  let revision: number
  if (mutation.kind === 'conversation.create') {
    if (mutation.baseRevision !== 0 || state.conversations.has(mutation.entityId)) {
      const result = { id: mutation.id, status: 'conflict', errorCode: 'SYNC_CONFLICT' } as const
      state.receipts.set(mutation.id, { requestHash: requestHash(mutation), result })
      return result
    }
    revision = 1
    state.conversations.set(mutation.entityId, {
      id: mutation.entityId,
      title: mutation.payload.title,
      revision,
      deleted: false,
    })
  } else if (
    mutation.kind === 'conversation.rename'
    || mutation.kind === 'conversation.delete'
    || mutation.kind === 'conversation.restore'
  ) {
    const conversation = state.conversations.get(mutation.entityId)
    if (!conversation || conversation.revision !== mutation.baseRevision) {
      const result = { id: mutation.id, status: 'conflict', errorCode: 'SYNC_CONFLICT' } as const
      state.receipts.set(mutation.id, { requestHash: requestHash(mutation), result })
      return result
    }
    revision = conversation.revision + 1
    conversation.revision = revision
    if (mutation.kind === 'conversation.rename') conversation.title = mutation.payload.title
    if (mutation.kind === 'conversation.delete') conversation.deleted = true
    if (mutation.kind === 'conversation.restore') conversation.deleted = false
  } else if (mutation.kind === 'message.append') {
    const existingMessage = state.messages.get(mutation.entityId)
    if (existingMessage) {
      const isIdentical = requestHash(existingMessage) === requestHash(mutation.payload)
      const conversation = state.conversations.get(existingMessage.conversationId)
      const result = isIdentical
        ? { id: mutation.id, status: 'duplicate', revision: conversation!.revision } as const
        : { id: mutation.id, status: 'rejected', errorCode: 'INVALID_INPUT' } as const
      state.receipts.set(mutation.id, { requestHash: requestHash(mutation), result })
      if (isIdentical) state.duplicateMutationCount += 1
      return result
    }
    const conversation = state.conversations.get(mutation.payload.conversationId)
    if (!conversation) {
      const result = { id: mutation.id, status: 'conflict', errorCode: 'SYNC_CONFLICT' } as const
      state.receipts.set(mutation.id, { requestHash: requestHash(mutation), result })
      return result
    }
    if (conversation.revision !== mutation.baseRevision) {
      const result = { id: mutation.id, status: 'conflict', errorCode: 'SYNC_CONFLICT' } as const
      state.receipts.set(mutation.id, { requestHash: requestHash(mutation), result })
      return result
    }
    revision = conversation.revision + 1
    conversation.revision = revision
    state.messages.set(mutation.entityId, { ...mutation.payload })
  } else if (mutation.kind === 'privacy.consent') {
    revision = 0
    state.consents.add(`${mutation.payload.purpose}\0${mutation.payload.documentVersion}`)
  } else if (mutation.kind === 'preferences.update') {
    if (state.preferences.revision !== mutation.baseRevision) {
      const result = { id: mutation.id, status: 'conflict', errorCode: 'SYNC_CONFLICT' } as const
      state.receipts.set(mutation.id, { requestHash: requestHash(mutation), result })
      return result
    }
    revision = state.preferences.revision + 1
    state.preferences = {
      ...mutation.payload,
      revision,
      updatedAt: mutation.occurredAt,
    }
  } else if (mutation.kind === 'usage.record') {
    revision = 0
    state.usage.set(mutation.payload.id, mutation.payload)
  } else {
    revision = 0
  }

  const result = { id: mutation.id, status: 'applied', revision } as const
  state.receipts.set(mutation.id, { requestHash: requestHash(mutation), result })
  appendEvent(state, mutation, revision)
  return result
}

function seedConversation(
  state: UserState,
  id: string,
  title: string,
  timestamp: string,
): void {
  const mutation: SyncMutation = {
    id: `seed_mutation_${id}`,
    kind: 'conversation.create',
    entityId: id,
    baseRevision: 0,
    occurredAt: timestamp,
    payload: {
      title,
      titleState: 'user_named',
      createdAt: timestamp,
      lastActivityAt: timestamp,
      metadataUpdatedAt: timestamp,
    },
  }
  applyMutation(state, mutation)
}

function importLegacyBatch(state: UserState, input: Record<string, unknown>) {
  const batchId = String(input.batchId)
  const conversations = Array.isArray(input.conversations) ? input.conversations : []
  const messages = Array.isArray(input.messages) ? input.messages : []
  const hash = importRequestHash(input)
  const existingHash = state.importedBatches.get(batchId)
  if (existingHash) {
    return existingHash === hash
      ? { batchId, status: 'duplicate' as const }
      : { batchId, status: 'rejected' as const, errorCode: 'SYNC_CONFLICT' as const }
  }
  let importedConversations = 0
  let importedMessages = 0
  for (const raw of conversations) {
    const conversation = raw as {
      id: string
      title: string
      titleState: 'pending' | 'generating' | 'ai_named' | 'user_named' | 'failed'
      createdAt: string
      lastActivityAt: string
      metadataUpdatedAt: string
    }
    if (state.conversations.has(conversation.id)) continue
    const mutation: SyncMutation = {
      id: importMutationId(batchId, 'conversation', conversation.id),
      kind: 'conversation.create',
      entityId: conversation.id,
      baseRevision: 0,
      occurredAt: conversation.createdAt,
      payload: {
        title: conversation.title,
        titleState: conversation.titleState,
        createdAt: conversation.createdAt,
        lastActivityAt: conversation.lastActivityAt,
        metadataUpdatedAt: conversation.metadataUpdatedAt,
      },
    }
    applyMutation(state, mutation)
    importedConversations += 1
  }
  for (const raw of messages) {
    const message = raw as {
      id: string
      conversationId: string
      role: 'user' | 'assistant'
      blocks: ChatBlock[]
      executionId?: string
      createdAt: string
    }
    const conversation = state.conversations.get(message.conversationId)
    if (!conversation || state.messages.has(message.id)) continue
    const mutation = {
      id: importMutationId(batchId, 'message', message.id),
      kind: 'message.append',
      entityId: message.id,
      baseRevision: conversation.revision,
      occurredAt: message.createdAt,
      payload: {
        id: message.id,
        conversationId: message.conversationId,
        role: message.role,
        blocks: message.blocks,
        ...(message.executionId === undefined ? {} : { executionId: message.executionId }),
        createdAt: message.createdAt,
      },
    } as SyncMutation
    applyMutation(state, mutation)
    importedMessages += 1
  }
  state.events.push({
    id: batchId,
    kind: 'legacy.import',
    entityId: batchId,
    baseRevision: 0,
    resultRevision: 0,
    payload: {
      batchId,
      includeUnowned: Boolean(input.includeUnowned),
    },
    receivedAt: receivedAt(state.events.length + 1),
  })
  state.importedBatches.set(batchId, hash)
  return {
    batchId,
    status: 'applied' as const,
    importedConversations,
    importedMessages,
  }
}

export async function startCloudUserDataFixture(): Promise<CloudUserDataFixture> {
  let users: Record<FixtureUser, UserState> = {
    alice: initialUserState(),
    bob: initialUserState(),
  }

  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/call') {
      sendJson(response, 404, { ok: false })
      return
    }
    const user = fixtureUser(request.headers['x-autoforge-fixture-user'] as string | undefined)
    if (!user) {
      sendJson(response, 401, { ok: false, error: { code: 'AUTH_REQUIRED' } })
      return
    }
    const state = users[user]
    if (!state.online) {
      sendJson(response, 503, { ok: false, error: { code: 'SERVICE_UNAVAILABLE' } })
      return
    }
    let input: Record<string, unknown>
    try {
      input = await readJson(request) as Record<string, unknown>
    } catch {
      sendJson(response, 400, { ok: false, error: { code: 'INVALID_INPUT' } })
      return
    }

    if (input.action === 'syncPush') {
      const mutations = Array.isArray(input.mutations) ? input.mutations as SyncMutation[] : []
      const results = mutations.map((mutation) => applyMutation(state, mutation))
      if (state.failAfterApplyAndPurge) {
        state.failAfterApplyAndPurge = false
        const appliedCreate = mutations.find((mutation, index): mutation is Extract<
          SyncMutation, { kind: 'conversation.create' }
        > => mutation.kind === 'conversation.create' && results[index]?.status === 'applied')
        if (!appliedCreate) throw new Error('Expected an applied create before fixture purge')
        deleteAndPurgeAppliedCreate(state, appliedCreate)
        sendJson(response, 503, { ok: false, error: { code: 'SERVICE_UNAVAILABLE' } })
        return
      }
      if (state.failAfterApply) {
        state.failAfterApply = false
        sendJson(response, 503, { ok: false, error: { code: 'SERVICE_UNAVAILABLE' } })
        return
      }
      sendJson(response, 200, {
        ok: true,
        data: {
          results,
          ...(state.events.length === 0 ? {} : { cursor: cursor(state.events.length) }),
        },
      })
      return
    }
    if (input.action === 'syncPull') {
      const offset = cursorOffset(input.cursor)
      if (offset === undefined || offset > state.events.length) {
        sendJson(response, 400, { ok: false, error: { code: 'INVALID_INPUT' } })
        return
      }
      const limit = typeof input.limit === 'number' ? input.limit : 100
      const mutations = state.events.slice(offset, offset + limit)
      const nextOffset = offset + mutations.length
      state.pullPageSizes.push(mutations.length)
      sendJson(response, 200, {
        ok: true,
        data: {
          mutations,
          cursor: nextOffset === 0 ? null : cursor(nextOffset),
        },
      })
      return
    }
    if (input.action === 'importLegacyBatch') {
      sendJson(response, 200, { ok: true, data: importLegacyBatch(state, input) })
      return
    }
    if (input.action === 'getUserDataPreferences') {
      sendJson(response, 200, { ok: true, data: state.preferences })
      return
    }
    if (input.action === 'getUsageSnapshot') {
      const usage = [...state.usage.values()]
      const estimated = usage.filter((event) => event.costStatus === 'estimated')
      const estimatedCents = estimated.reduce((total, event) => (
        total + Math.round(Number(event.estimatedCostUsd) * 100)
      ), 0)
      sendJson(response, 200, {
        ok: true,
        data: {
          startedAt: input.startedAt,
          endedAt: input.endedAt,
          inputTokens: usage.reduce((total, event) => total + (event.inputTokens ?? 0), 0),
          outputTokens: usage.reduce((total, event) => total + (event.outputTokens ?? 0), 0),
          estimatedCostUsd: (estimatedCents / 100).toFixed(2).replace(/\.00$/u, ''),
          estimatedCount: estimated.length,
          unavailableCount: usage.filter((event) => event.costStatus === 'unavailable').length,
        },
      })
      return
    }
    sendJson(response, 400, { ok: false, error: { code: 'INVALID_INPUT' } })
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Cloud user-data fixture did not bind')

  return {
    origin: `http://127.0.0.1:${address.port}`,
    async reset() {
      users = { alice: initialUserState(), bob: initialUserState() }
    },
    async close() {
      server.close()
      await once(server, 'close')
    },
    async setOnline(user, online) {
      users[user].online = online
    },
    async failAfterApplyOnce(user) {
      users[user].failAfterApply = true
    },
    async failAfterApplyAndPurgeOnce(user) {
      users[user].failAfterApplyAndPurge = true
    },
    async retryPurgedMutationWithChangedContent(user) {
      const identity = users[user].purgedCreateIdentity
      if (!identity) throw new Error('No purged create mutation is available')
      return applyMutation(users[user], {
        ...identity,
        payload: {
          title: 'Changed title after purge',
          titleState: 'user_named',
          createdAt: identity.occurredAt,
          lastActivityAt: identity.occurredAt,
          metadataUpdatedAt: identity.occurredAt,
        },
      })
    },
    async seedConversations(user, count, titlePrefix) {
      const state = users[user]
      for (let index = 0; index < count; index += 1) {
        const timestamp = new Date(Date.UTC(2026, 7, 25, 0, 0, index)).toISOString()
        seedConversation(
          state,
          `seed_conversation_${String(index).padStart(3, '0')}`,
          `${titlePrefix} ${String(index + 1).padStart(2, '0')}`,
          timestamp,
        )
      }
    },
    async seedByokUsage(user) {
      const state = users[user]
      const events: ByokUsageEvent[] = [
        {
          id: 'usage_estimated',
          operationId: 'operation_estimated',
          purpose: 'assistant_reply',
          credentialOwner: 'user',
          billable: false,
          provider: 'openrouter',
          model: 'openrouter/e2e',
          modality: 'text',
          inputTokens: 4,
          outputTokens: 6,
          costStatus: 'estimated',
          estimatedCostUsd: '0.01',
          occurredAt: '2026-08-25T00:00:00.000Z',
        },
        {
          id: 'usage_unavailable',
          operationId: 'operation_unavailable',
          purpose: 'media_generation',
          credentialOwner: 'user',
          billable: false,
          provider: 'deepseek',
          model: 'deepseek/e2e',
          modality: 'video',
          costStatus: 'unavailable',
          occurredAt: '2026-08-25T00:00:01.000Z',
        },
      ]
      for (const event of events) state.usage.set(event.id, event)
    },
    async snapshot(user) {
      const state = users[user]
      return {
        conversations: [...state.conversations.values()]
          .map((conversation) => ({ ...conversation }))
          .sort((left, right) => left.id.localeCompare(right.id)),
        consentCount: state.consents.size,
        importedBatchCount: state.importedBatches.size,
        duplicateMutationCount: state.duplicateMutationCount,
        pullPageSizes: [...state.pullPageSizes],
        compactedConversationEventCount: state.events.filter((event) => (
          eventConversationId(event) !== undefined && 'compacted' in event
        )).length,
        retainedConversationPayloadCount: state.events.filter((event) => (
          eventConversationId(event) !== undefined && 'payload' in event
        )).length,
      }
    },
  }
}
