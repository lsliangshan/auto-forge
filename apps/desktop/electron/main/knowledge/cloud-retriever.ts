import { z } from 'zod'
import {
  knowledgeSearchResultSchema,
  type KnowledgeSearchResult,
} from '@autoforge/shared'
import { CloudKnowledgeError } from './cloudbase-knowledge-client.js'

export const CLOUD_EMBEDDING_MODEL = 'kinfra-text-embedding-0.6b' as const
export const CLOUD_EMBEDDING_DIMENSIONS = 1024 as const
export const CLOUD_RETRIEVAL_TOP_K = 8 as const

const identifier = z.string().trim().min(1).max(128)
const generationSchema = z.object({
  knowledgeBaseId: identifier,
  generationId: identifier,
}).strict()
const generationListSchema = z.array(generationSchema).max(32).superRefine((generations, context) => {
  if (new Set(generations.map(({ knowledgeBaseId }) => knowledgeBaseId)).size !== generations.length) {
    context.addIssue({ code: 'custom', message: 'Knowledge base generations must be unique' })
  }
})
const publishedResultSchema = z.object({
  generationId: identifier,
  evidence: knowledgeSearchResultSchema,
}).strict()
const remoteResultSchema = z.object({
  mode: z.enum(['hybrid', 'keyword_only']),
  degradationReason: z.enum([
    'consent_unavailable', 'provider_unavailable', 'model_deprecated', 'small_index_limit',
  ]).nullable(),
  results: z.array(publishedResultSchema).max(CLOUD_RETRIEVAL_TOP_K),
}).strict()

export interface CloudPublishedGeneration {
  readonly knowledgeBaseId: string
  readonly generationId: string
}

export interface CloudGenerationSnapshot {
  readonly generations: readonly CloudPublishedGeneration[]
}

export interface CloudPublishedSearchResult {
  readonly mode: 'hybrid' | 'keyword_only'
  readonly degradationReason:
    | 'consent_unavailable'
    | 'provider_unavailable'
    | 'model_deprecated'
    | 'small_index_limit'
    | null
  readonly results: KnowledgeSearchResult[]
}

export interface CloudHybridRetrievalPort {
  capturePublishedSnapshot(input: {
    knowledgeBaseIds: string[]
  }): Promise<CloudPublishedGeneration[]>
  searchPublished(input: {
    query: string
    generationSnapshot: CloudPublishedGeneration[]
    topK: number
  }): Promise<{
    mode: 'hybrid' | 'keyword_only'
    degradationReason: CloudPublishedSearchResult['degradationReason']
    results: Array<{ generationId: string; evidence: KnowledgeSearchResult }>
  }>
}

export interface CloudRetrievalLogger {
  info(event: string, fields: Record<string, string | number | boolean | null>): void
}

export class CloudRetriever {
  private readonly snapshots = new WeakSet<object>()

  constructor(
    private readonly remote: CloudHybridRetrievalPort,
    private readonly logger?: CloudRetrievalLogger,
  ) {}

  async captureSnapshot(knowledgeBaseIds: string[]): Promise<CloudGenerationSnapshot> {
    const scope = z.array(identifier).min(1).max(32).superRefine((ids, context) => {
      if (new Set(ids).size !== ids.length) {
        context.addIssue({ code: 'custom', message: 'Knowledge base IDs must be unique' })
      }
    }).safeParse(knowledgeBaseIds)
    if (!scope.success) throw new CloudKnowledgeError('INVALID_INPUT')
    const response = generationListSchema.safeParse(await this.remote.capturePublishedSnapshot({
      knowledgeBaseIds: scope.data,
    }))
    if (!response.success
      || response.data.length !== scope.data.length
      || response.data.some(({ knowledgeBaseId }) => !scope.data.includes(knowledgeBaseId))) {
      throw new CloudKnowledgeError('INTERNAL_ERROR')
    }
    const byKnowledgeBase = new Map(response.data.map(generation => [generation.knowledgeBaseId, generation]))
    const generations = Object.freeze(scope.data.map(knowledgeBaseId => Object.freeze({
      ...byKnowledgeBase.get(knowledgeBaseId)!,
    })))
    const snapshot = Object.freeze({ generations })
    this.snapshots.add(snapshot)
    return snapshot
  }

  async search(snapshot: CloudGenerationSnapshot, query: string): Promise<CloudPublishedSearchResult> {
    if (!this.snapshots.has(snapshot as object)) throw new CloudKnowledgeError('INVALID_INPUT')
    const parsedQuery = z.string().trim().min(1).max(1_000).safeParse(query)
    if (!parsedQuery.success) throw new CloudKnowledgeError('INVALID_INPUT')
    const generationSnapshot = snapshot.generations.map(generation => ({ ...generation }))
    const response = remoteResultSchema.safeParse(await this.remote.searchPublished({
      query: parsedQuery.data,
      generationSnapshot,
      topK: CLOUD_RETRIEVAL_TOP_K,
    }))
    if (!response.success) throw new CloudKnowledgeError('INTERNAL_ERROR')
    const allowed = new Map(generationSnapshot.map(
      ({ generationId, knowledgeBaseId }) => [generationId, knowledgeBaseId],
    ))
    if (response.data.results.some(({ generationId, evidence }) => (
      allowed.get(generationId) !== evidence.knowledgeBaseId
    ))) {
      throw new CloudKnowledgeError('INTERNAL_ERROR')
    }
    this.logger?.info('knowledge_cloud_retrieval_completed', {
      mode: response.data.mode,
      degradationReason: response.data.degradationReason,
      generationCount: generationSnapshot.length,
      resultCount: response.data.results.length,
    })
    return {
      mode: response.data.mode,
      degradationReason: response.data.degradationReason,
      results: response.data.results.map(({ evidence }) => evidence),
    }
  }
}
