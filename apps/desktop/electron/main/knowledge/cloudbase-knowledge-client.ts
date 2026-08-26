import { z } from 'zod'
import { knowledgeSearchResultSchema } from '@autoforge/shared'

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
  'EMBEDDING_CONSENT_REQUIRED',
  'EMBEDDING_MODEL_INVALID',
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
  hasMore: z.boolean(),
  changes: z.array(changeSchema).max(1_000),
}).strict()
const staleCursorSchema = z.object({ kind: z.literal('cursor_stale') }).strict()
export type CloudPullChangesResult = z.infer<typeof changesSchema> | z.infer<typeof staleCursorSchema>
const snapshotSchema = z.object({
  kind: z.literal('snapshot'),
  nextSequence: z.number().int().nonnegative(),
  changes: z.array(changeSchema).max(100_000),
}).strict()

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
  uploadAuthorization: z.object({
    url: z.string().url().refine(value => value.startsWith('https://')),
    method: z.literal('PUT'),
    headers: z.record(z.string(), z.string().max(1_024)),
    expiresAt: z.string().datetime(),
  }).strict(),
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
const embeddingBaseRetrievalSchema = z.object({
  knowledgeBaseId: identifier,
  retrievalMode: z.enum(['hybrid', 'keyword_only', 'reindexing']),
}).strict()
const embeddingConsentSchema = z.object({
  processor: z.literal('tokenhub'),
  processingRegion: z.literal('Guangzhou'),
  model: z.literal('kinfra-text-embedding-0.6b'),
  dimensions: z.literal(1024),
  status: z.enum(['unknown', 'granted', 'denied', 'revoked']),
  retrievalByBase: z.array(embeddingBaseRetrievalSchema).max(1_000).refine(
    states => new Set(states.map(({ knowledgeBaseId }) => knowledgeBaseId)).size === states.length,
    { message: 'Knowledge base retrieval states must be unique' },
  ),
  updatedAt: z.string().datetime().optional(),
}).strict().superRefine(({ status, retrievalByBase }, context) => {
  if (status !== 'granted'
    && retrievalByBase.some(({ retrievalMode }) => retrievalMode !== 'keyword_only')) {
    context.addIssue({ code: 'custom', path: ['retrievalByBase'], message: 'Consent is required' })
  }
})
const publishedGenerationSchema = z.object({
  knowledgeBaseId: identifier,
  generationId: identifier,
}).strict()
const publishedGenerationListSchema = z.array(publishedGenerationSchema).max(32).superRefine(
  (generations, context) => {
    if (new Set(generations.map(({ knowledgeBaseId }) => knowledgeBaseId)).size !== generations.length) {
      context.addIssue({ code: 'custom', message: 'Knowledge base generations must be unique' })
    }
  },
)
const publishedSearchSchema = z.object({
  mode: z.enum(['hybrid', 'keyword_only']),
  degradationReason: z.enum([
    'consent_unavailable', 'provider_unavailable', 'model_deprecated', 'small_index_limit',
  ]).nullable(),
  results: z.array(z.object({
    generationId: identifier,
    evidence: knowledgeSearchResultSchema,
  }).strict()).max(8),
}).strict()
const driftProbeSchema = z.discriminatedUnion('drifted', [
  z.object({
    drifted: z.literal(false),
    publishedGenerationId: identifier.nullable(),
  }).strict(),
  publishedSchema.extend({ drifted: z.literal(true) }).strict(),
])

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

  getEmbeddingConsent(): Promise<z.infer<typeof embeddingConsentSchema>> {
    return this.invoke('getEmbeddingConsent', {}, embeddingConsentSchema)
  }

  setEmbeddingConsent(input: {
    requestId: string
    status: 'granted' | 'denied' | 'revoked'
  }): Promise<z.infer<typeof embeddingConsentSchema>> {
    const parsed = z.object({
      requestId: identifier,
      status: z.enum(['granted', 'denied', 'revoked']),
    }).strict().safeParse(input)
    if (!parsed.success) return Promise.reject(new CloudKnowledgeError('INVALID_INPUT'))
    return this.invoke('setEmbeddingConsent', parsed.data, embeddingConsentSchema)
  }

  capturePublishedSnapshot(input: {
    knowledgeBaseIds: string[]
  }): Promise<Array<z.infer<typeof publishedGenerationSchema>>> {
    const parsed = z.object({
      knowledgeBaseIds: z.array(identifier).min(1).max(32).refine(
        ids => new Set(ids).size === ids.length,
        { message: 'Knowledge base IDs must be unique' },
      ),
    }).strict().safeParse(input)
    if (!parsed.success) return Promise.reject(new CloudKnowledgeError('INVALID_INPUT'))
    return this.invoke('capturePublishedSnapshot', parsed.data, publishedGenerationListSchema)
  }

  searchPublished(input: {
    query: string
    generationSnapshot: Array<z.infer<typeof publishedGenerationSchema>>
    topK: number
  }): Promise<z.infer<typeof publishedSearchSchema>> {
    const parsed = z.object({
      query: z.string().trim().min(1).max(1_000),
      generationSnapshot: publishedGenerationListSchema.min(1),
      topK: z.number().int().min(1).max(8),
    }).strict().safeParse(input)
    if (!parsed.success) return Promise.reject(new CloudKnowledgeError('INVALID_INPUT'))
    return this.invoke('searchPublished', parsed.data, publishedSearchSchema)
  }

  buildEmbeddingGeneration(input: {
    requestId: string
    knowledgeBaseId: string
    generationId: string
    expectedPublishedGenerationId: string | null
  }): Promise<z.infer<typeof publishedSchema>> {
    const parsed = z.object({
      requestId: identifier,
      knowledgeBaseId: identifier,
      generationId: identifier,
      expectedPublishedGenerationId: identifier.nullable(),
    }).strict().safeParse(input)
    if (!parsed.success) return Promise.reject(new CloudKnowledgeError('INVALID_INPUT'))
    return this.invoke('buildEmbeddingGeneration', parsed.data, publishedSchema)
  }

  probeEmbeddingDrift(input: {
    requestId: string
    knowledgeBaseId: string
    generationId: string
    expectedPublishedGenerationId: string | null
  }): Promise<z.infer<typeof driftProbeSchema>> {
    const parsed = z.object({
      requestId: identifier,
      knowledgeBaseId: identifier,
      generationId: identifier,
      expectedPublishedGenerationId: identifier.nullable(),
    }).strict().safeParse(input)
    if (!parsed.success) return Promise.reject(new CloudKnowledgeError('INVALID_INPUT'))
    return this.invoke('probeEmbeddingDrift', parsed.data, driftProbeSchema)
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
      && !validPage(result, parsed.data.afterSequence)) {
      throw new CloudKnowledgeError('INTERNAL_ERROR')
    }
    return result
  }

  fullResync(input: { knowledgeBaseId: string }): Promise<z.infer<typeof snapshotSchema>> {
    const parsed = z.object({ knowledgeBaseId: identifier }).strict().safeParse(input)
    if (!parsed.success) return Promise.reject(new CloudKnowledgeError('INVALID_INPUT'))
    return this.invoke('fullResync', parsed.data, snapshotSchema)
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
      storageReferences: z.array(z.string().trim().min(1).max(512)).min(1).max(100),
    }).strict().safeParse(input)
    if (!parsed.success) return Promise.reject(new CloudKnowledgeError('INVALID_INPUT'))
    return this.invoke('cleanupOrphans', parsed.data, z.object({ removed: z.number().int().nonnegative() }).strict())
  }

  completeUpload(input: { uploadTicket: string }): Promise<{
    objectId: string
    storageReference: string
    verified: true
  }> {
    const parsed = z.object({ uploadTicket: identifier }).strict().safeParse(input)
    if (!parsed.success) return Promise.reject(new CloudKnowledgeError('INVALID_INPUT'))
    return this.invoke('completeUpload', parsed.data, z.object({
      objectId: identifier,
      storageReference: z.string().trim().min(1).max(512),
      verified: z.literal(true),
    }).strict())
  }

  getJob(input: { jobId: string }): Promise<{
    jobId: string
    state: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
    errorCode: string | null
  }> {
    const parsed = z.object({ jobId: identifier }).strict().safeParse(input)
    if (!parsed.success) return Promise.reject(new CloudKnowledgeError('INVALID_INPUT'))
    return this.invoke('getJob', parsed.data, z.object({
      jobId: identifier,
      state: z.enum(['queued', 'running', 'paused', 'completed', 'failed', 'cancelled']),
      errorCode: z.string().max(64).nullable(),
    }).strict())
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

function validPage(
  page: z.infer<typeof changesSchema>,
  afterSequence: number,
): boolean {
  let previous = afterSequence
  for (const change of page.changes) {
    if (change.sequence <= previous) return false
    previous = change.sequence
  }
  if (page.changes.length === 0) {
    return !page.hasMore && page.nextSequence === afterSequence
  }
  return page.nextSequence === previous && (!page.hasMore || page.nextSequence > afterSequence)
}
