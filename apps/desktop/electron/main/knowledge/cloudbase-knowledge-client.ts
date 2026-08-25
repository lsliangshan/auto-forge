import { z } from 'zod'

export interface CloudBaseFunctionPort {
  callFunction(options: { name: string; data: Record<string, unknown> }): Promise<unknown>
}

export const cloudKnowledgeErrorCodes = [
  'AUTH_REQUIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID_INPUT',
  'CONFLICT',
  'CURSOR_STALE',
  'GENERATION_NOT_READY',
  'ENTITLEMENT_REQUIRED',
  'KILL_SWITCH_ENABLED',
  'TRANSIENT_FAILURE',
  'INTERNAL_ERROR',
] as const
export type CloudKnowledgeErrorCode = typeof cloudKnowledgeErrorCodes[number]

const retryableCodes = new Set<CloudKnowledgeErrorCode>(['TRANSIENT_FAILURE'])

export class CloudKnowledgeError extends Error {
  readonly retryable: boolean

  constructor(readonly code: CloudKnowledgeErrorCode) {
    super(code)
    this.name = 'CloudKnowledgeError'
    this.retryable = retryableCodes.has(code)
  }
}

const identifier = z.string().trim().min(1).max(128)
const revision = z.string().trim().min(1).max(128)
const payload = z.record(z.string(), z.unknown())
const entityKind = z.enum(['knowledge_base', 'document', 'metadata'])
const operation = z.enum(['upsert', 'delete'])

const changeSchema = z.object({
  sequence: z.number().int().nonnegative(),
  entityKind,
  entityId: identifier,
  operation,
  revision,
  payload,
}).strict()
export type CloudKnowledgeChange = z.infer<typeof changeSchema>

const pushResultSchema = z.discriminatedUnion('status', [
  z.object({
    mutationId: identifier,
    status: z.enum(['applied', 'duplicate']),
    sequence: z.number().int().nonnegative(),
    revision,
  }).strict(),
  z.object({
    mutationId: identifier,
    status: z.literal('conflict'),
    conflictKind: z.enum(['content', 'delete_vs_update']),
    localRevision: revision,
    remoteRevision: revision,
    sequence: z.number().int().nonnegative(),
  }).strict(),
])
export type CloudPushMutationResult = z.infer<typeof pushResultSchema>

const changesSchema = z.object({
  kind: z.literal('incremental'),
  nextSequence: z.number().int().nonnegative(),
  changes: z.array(changeSchema).max(1_000),
}).strict()
const staleCursorSchema = z.object({ kind: z.literal('cursor_stale') }).strict()
export type CloudPullChangesResult = z.infer<typeof changesSchema> | z.infer<typeof staleCursorSchema>

const publishedSchema = z.object({
  generationId: identifier,
  previousGenerationId: identifier.nullable(),
  sequence: z.number().int().nonnegative(),
}).strict()
const uploadAuthorizationSchema = z.object({
  uploadTicket: identifier,
  storageReference: z.string().trim().min(1).max(512),
  objectId: identifier,
  jobId: identifier,
  expiresAt: z.string().datetime(),
}).strict()
const cloudEntitlementSchema = z.object({
  tier: z.enum(['free', 'member']),
  status: z.enum(['active', 'offline_grace', 'expired', 'unavailable']),
  betaEnabled: z.boolean(),
  cloudEnabled: z.boolean(),
  killSwitchEnabled: z.boolean(),
  version: z.number().int().nonnegative(),
  validUntil: z.string().datetime().nullable(),
}).strict()
const beginSyncSchema = z.object({
  knowledgeBaseId: identifier,
  generationId: identifier,
  status: z.literal('staging'),
}).strict()

const successEnvelope = z.object({ ok: z.literal(true), data: z.unknown() }).strict()
const failureEnvelope = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.enum(cloudKnowledgeErrorCodes) }).strict(),
}).strict()
const functionEnvelope = z.object({ result: z.unknown() }).passthrough()

function checkedPayload(value: Record<string, unknown>): Record<string, unknown> {
  let encoded: string
  try { encoded = JSON.stringify(value) } catch { throw new CloudKnowledgeError('INVALID_INPUT') }
  if (Buffer.byteLength(encoded, 'utf8') > 64 * 1_024) throw new CloudKnowledgeError('INVALID_INPUT')
  return value
}

export interface PushMutationInput {
  mutationId: string
  knowledgeBaseId: string
  entityKind: 'knowledge_base' | 'document' | 'metadata'
  entityId: string
  operation: 'upsert' | 'delete'
  baseRevision: string | null
  payload: Record<string, unknown>
}

export interface PublishGenerationInput {
  requestId: string
  knowledgeBaseId: string
  generationId: string
  expectedPublishedGenerationId: string | null
}

export class CloudBaseKnowledgeClient {
  constructor(
    private readonly functions: CloudBaseFunctionPort,
    private readonly functionName = 'autoforge-knowledge',
  ) {}

  authorizeUpload(input: {
    requestId: string
    knowledgeBaseId: string
    documentId: string
    versionId: string
    byteSize: number
    sha256: string
  }): Promise<z.infer<typeof uploadAuthorizationSchema>> {
    const parsed = z.object({
      requestId: identifier,
      knowledgeBaseId: identifier,
      documentId: identifier,
      versionId: identifier,
      byteSize: z.number().int().positive().max(512 * 1_024 * 1_024),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict().safeParse(input)
    if (!parsed.success) return Promise.reject(new CloudKnowledgeError('INVALID_INPUT'))
    return this.invoke('authorizeUpload', parsed.data, uploadAuthorizationSchema)
  }

  getEntitlement(): Promise<z.infer<typeof cloudEntitlementSchema>> {
    return this.invoke('getEntitlement', {}, cloudEntitlementSchema)
  }

  beginSync(input: {
    requestId: string
    knowledgeBaseId: string
    name: string
    revision: string
    generationId: string
  }): Promise<z.infer<typeof beginSyncSchema>> {
    const parsed = z.object({
      requestId: identifier,
      knowledgeBaseId: identifier,
      name: z.string().trim().min(1).max(200),
      revision,
      generationId: identifier,
    }).strict().safeParse(input)
    if (!parsed.success) return Promise.reject(new CloudKnowledgeError('INVALID_INPUT'))
    return this.invoke('beginSync', parsed.data, beginSyncSchema)
  }

  async pushMutation(input: PushMutationInput): Promise<CloudPushMutationResult> {
    const parsed = z.object({
      mutationId: identifier,
      knowledgeBaseId: identifier,
      entityKind,
      entityId: identifier,
      operation,
      baseRevision: revision.nullable(),
      payload,
    }).strict().safeParse(input)
    if (!parsed.success) throw new CloudKnowledgeError('INVALID_INPUT')
    parsed.data.payload = checkedPayload(parsed.data.payload)
    return this.invoke('pushMutation', parsed.data, pushResultSchema)
  }

  async pullChanges(input: { knowledgeBaseId: string; afterSequence: number }): Promise<CloudPullChangesResult> {
    const parsed = z.object({
      knowledgeBaseId: identifier,
      afterSequence: z.number().int().nonnegative(),
    }).strict().safeParse(input)
    if (!parsed.success) return Promise.reject(new CloudKnowledgeError('INVALID_INPUT'))
    const result = await this.invoke(
      'pullChanges', { ...parsed.data, limit: 1_000 }, z.union([changesSchema, staleCursorSchema]),
    )
    if (result.kind === 'incremental'
      && (result.nextSequence < parsed.data.afterSequence
        || result.changes.some(change => change.sequence > result.nextSequence))) {
      throw new CloudKnowledgeError('INTERNAL_ERROR')
    }
    return result
  }

  fullResync(input: { knowledgeBaseId: string }): Promise<z.infer<typeof changesSchema>> {
    const parsed = z.object({ knowledgeBaseId: identifier }).strict().safeParse(input)
    if (!parsed.success) return Promise.reject(new CloudKnowledgeError('INVALID_INPUT'))
    return this.invoke('fullResync', parsed.data, changesSchema)
  }

  publishGeneration(input: PublishGenerationInput): Promise<z.infer<typeof publishedSchema>> {
    const parsed = z.object({
      requestId: identifier,
      knowledgeBaseId: identifier,
      generationId: identifier,
      expectedPublishedGenerationId: identifier.nullable(),
    }).strict().safeParse(input)
    if (!parsed.success) return Promise.reject(new CloudKnowledgeError('INVALID_INPUT'))
    return this.invoke('publishGeneration', parsed.data, publishedSchema)
  }

  async deleteKnowledgeBase(input: {
    requestId: string
    knowledgeBaseId: string
    expectedPublishedGenerationId: string | null
  }): Promise<{ deletionJobId: string }> {
    const schema = z.object({ deletionJobId: identifier }).strict()
    const parsed = z.object({
      requestId: identifier,
      knowledgeBaseId: identifier,
      expectedPublishedGenerationId: identifier.nullable(),
    }).strict().safeParse(input)
    if (!parsed.success) throw new CloudKnowledgeError('INVALID_INPUT')
    return this.invoke('deleteKnowledgeBase', parsed.data, schema)
  }

  async cancelJob(input: { requestId: string; jobId: string }): Promise<void> {
    const parsed = z.object({ requestId: identifier, jobId: identifier }).strict().safeParse(input)
    if (!parsed.success) throw new CloudKnowledgeError('INVALID_INPUT')
    await this.invoke('cancelJob', parsed.data, z.object({ cancelled: z.boolean() }).strict())
  }

  cleanupOrphans(input: {
    requestId: string
    knowledgeBaseId: string
    storageReferences: string[]
  }): Promise<{ removed: number }> {
    const parsed = z.object({
      requestId: identifier,
      knowledgeBaseId: identifier,
      storageReferences: z.array(identifier).min(1).max(100),
    }).strict().safeParse(input)
    if (!parsed.success) return Promise.reject(new CloudKnowledgeError('INVALID_INPUT'))
    return this.invoke('cleanupOrphans', parsed.data, z.object({ removed: z.number().int().nonnegative() }).strict())
  }

  private async invoke<T>(action: string, data: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    let response: unknown
    try {
      response = await this.functions.callFunction({
        name: this.functionName,
        data: { action, ...data },
      })
    } catch {
      throw new CloudKnowledgeError('TRANSIENT_FAILURE')
    }
    const outer = functionEnvelope.safeParse(response)
    if (!outer.success) throw new CloudKnowledgeError('INTERNAL_ERROR')
    const failed = failureEnvelope.safeParse(outer.data.result)
    if (failed.success) throw new CloudKnowledgeError(failed.data.error.code)
    const succeeded = successEnvelope.safeParse(outer.data.result)
    if (!succeeded.success) throw new CloudKnowledgeError('INTERNAL_ERROR')
    const result = schema.safeParse(succeeded.data.data)
    if (!result.success) throw new CloudKnowledgeError('INTERNAL_ERROR')
    return result.data
  }
}
