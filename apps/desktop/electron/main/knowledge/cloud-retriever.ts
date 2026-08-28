import { reciprocalRankFusion } from './reciprocal-rank-fusion'

export const fixedCloudEmbeddingConfiguration = Object.freeze({
  model: 'kinfra-text-embedding-0.6b',
  dimensions: 1024,
  configurationVersion: 'autoforge-knowledge-embedding-v1',
  region: 'guangzhou',
} as const)

export interface CloudCandidate {
  id: string
  knowledgeBaseId: string
  documentId: string
  versionId: string
  generationId: string
  rank: number
  body: string
  coordinates: Record<string, unknown>
}

type RetrievalStrategy = 'hybrid' | 'keyword_only_consent' | 'keyword_only_provider'
  | 'keyword_only_rebuild'

const maximumResponseBytes = 1024 * 1024
const maximumCandidates = 24
const maximumCandidateBodyBytes = 64 * 1024
const maximumCoordinatesBytes = 8 * 1024
const encoder = new TextEncoder()

export interface CloudSearchResponse {
  generationState: 'published' | string
  generations: Array<{
    knowledgeBaseId: string
    generationId: string
    previousGenerationId: string | null
  }>
  strategy: RetrievalStrategy
  embedding: typeof fixedCloudEmbeddingConfiguration | {
    model: string
    dimensions: number
    configurationVersion: string
    region: string
  }
  keywordCandidates: CloudCandidate[]
  vectorCandidates: CloudCandidate[]
  driftProbeRequired: boolean
}

export interface CloudSearchGateway {
  search(input: {
    query: string
    knowledgeBaseIds: string[]
    limit: number
  }): Promise<CloudSearchResponse>
}

function matchesFixedConfiguration(value: CloudSearchResponse['embedding']): boolean {
  return value.model === fixedCloudEmbeddingConfiguration.model
    && value.dimensions === fixedCloudEmbeddingConfiguration.dimensions
    && value.configurationVersion === fixedCloudEmbeddingConfiguration.configurationVersion
    && value.region === fixedCloudEmbeddingConfiguration.region
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
}

function serializedBytes(value: unknown): number {
  try { return encoder.encode(JSON.stringify(value)).byteLength } catch { return Number.POSITIVE_INFINITY }
}

function validCandidate(candidate: CloudCandidate, generationId: string): boolean {
  return hasExactKeys(candidate, [
    'id', 'knowledgeBaseId', 'documentId', 'versionId', 'generationId',
    'rank', 'body', 'coordinates',
  ]) && Boolean(candidate.id && candidate.knowledgeBaseId && candidate.documentId
    && candidate.versionId && candidate.generationId === generationId
    && Number.isSafeInteger(candidate.rank) && candidate.rank > 0
    && typeof candidate.body === 'string' && candidate.coordinates
    && encoder.encode(candidate.body).byteLength <= maximumCandidateBodyBytes
    && typeof candidate.coordinates === 'object' && !Array.isArray(candidate.coordinates)
    && serializedBytes(candidate.coordinates) <= maximumCoordinatesBytes)
}

function candidateIdentity(candidate: { knowledgeBaseId: string; id: string }): string {
  return `${candidate.knowledgeBaseId.length}:${candidate.knowledgeBaseId}${candidate.id}`
}

function validCandidateList(
  candidates: CloudCandidate[],
  generationByBase: ReadonlyMap<string, string>,
): boolean {
  if (candidates.length > maximumCandidates) return false
  const identities = new Set<string>()
  const ranks = new Set<number>()
  for (const candidate of candidates) {
    const identity = candidateIdentity(candidate)
    if (!validCandidate(candidate, generationByBase.get(candidate.knowledgeBaseId) ?? '')
      || candidate.rank > candidates.length
      || identities.has(identity) || ranks.has(candidate.rank)) return false
    identities.add(identity)
    ranks.add(candidate.rank)
  }
  return true
}

export class CloudKnowledgeRetriever {
  constructor(private readonly gateway: CloudSearchGateway) {}

  async search(
    query: string,
    knowledgeBaseIds: readonly string[],
    expectedGenerations?: ReadonlyMap<string, string>,
  ) {
    const response = await this.gateway.search({
      query,
      knowledgeBaseIds: [...knowledgeBaseIds],
      limit: 24,
    })
    if (serializedBytes(response) > maximumResponseBytes || !hasExactKeys(response, [
      'generationState', 'generations', 'strategy', 'embedding',
      'keywordCandidates', 'vectorCandidates', 'driftProbeRequired',
    ]) || response.generationState !== 'published'
      || !Array.isArray(response.generations)
      || response.generations.some(item => !hasExactKeys(item, [
        'knowledgeBaseId', 'generationId', 'previousGenerationId',
      ]) || typeof item.knowledgeBaseId !== 'string'
        || typeof item.generationId !== 'string'
        || !(item.previousGenerationId === null
          || typeof item.previousGenerationId === 'string'))
      || !Array.isArray(response.keywordCandidates)
      || !Array.isArray(response.vectorCandidates)
      || ![
        'hybrid', 'keyword_only_consent', 'keyword_only_provider', 'keyword_only_rebuild',
      ].includes(response.strategy)
      || !hasExactKeys(response.embedding, [
        'model', 'dimensions', 'configurationVersion', 'region',
      ])
      || typeof response.driftProbeRequired !== 'boolean') {
      throw { code: 'INVALID_CLOUD_RETRIEVAL_RESPONSE' }
    }
    const generationByBase = new Map(response.generations.map(item => [
      item.knowledgeBaseId, item.generationId,
    ]))
    if (response.generations.length !== knowledgeBaseIds.length
      || response.generations.length > 8
      || generationByBase.size !== knowledgeBaseIds.length
      || knowledgeBaseIds.some(id => !generationByBase.has(id))
      || (expectedGenerations !== undefined
        && (expectedGenerations.size !== knowledgeBaseIds.length
          || knowledgeBaseIds.some(id => generationByBase.get(id) !== expectedGenerations.get(id))))
      || !validCandidateList(response.keywordCandidates, generationByBase)
      || !validCandidateList(response.vectorCandidates, generationByBase)
      || (response.strategy !== 'hybrid' && response.vectorCandidates.length !== 0)
      || (response.strategy === 'keyword_only_rebuild') !== response.driftProbeRequired) {
      throw { code: 'INVALID_CLOUD_RETRIEVAL_RESPONSE' }
    }

    if (!matchesFixedConfiguration(response.embedding)) {
      return {
        strategy: 'keyword_only_drift' as const,
        generations: response.generations,
        driftProbeRequired: true,
        evidence: response.keywordCandidates.slice(0, 8),
      }
    }

    const byId = new Map(
      [...response.keywordCandidates, ...response.vectorCandidates]
        .map(item => [candidateIdentity(item), item]),
    )
    const fused = reciprocalRankFusion([
      [...response.keywordCandidates].sort((a, b) => a.rank - b.rank
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      [...response.vectorCandidates].sort((a, b) => a.rank - b.rank
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    ], { limit: 8 })
    return {
      strategy: response.strategy,
      generations: response.generations,
      driftProbeRequired: response.driftProbeRequired,
      evidence: fused.map(item => byId.get(candidateIdentity(item))!).filter(Boolean),
    }
  }
}
