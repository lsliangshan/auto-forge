import { describe, expect, it, vi } from 'vitest'
import { CloudKnowledgeRetriever, fixedCloudEmbeddingConfiguration } from './cloud-retriever'

const candidate = (id: string, rank: number, generationId = 'generation_current') => ({
  id,
  knowledgeBaseId: 'kb_1',
  documentId: 'document_1',
  versionId: 'version_1',
  generationId,
  rank,
  body: `evidence-${id}`,
  coordinates: { kind: 'txt', lineStart: rank, lineEnd: rank },
})

describe('CloudKnowledgeRetriever', () => {
  it('fuses keyword and vector candidates deterministically', async () => {
    const search = vi.fn().mockResolvedValue({
      generationState: 'published', generations: [{ knowledgeBaseId: 'kb_1',
        generationId: 'generation_current', previousGenerationId: 'generation_previous' }],
      strategy: 'hybrid',
      embedding: fixedCloudEmbeddingConfiguration,
      keywordCandidates: [candidate('chunk_b', 1), candidate('chunk_a', 2)],
      vectorCandidates: [candidate('chunk_a', 1), candidate('chunk_b', 2)],
      driftProbeRequired: false,
    })
    const retriever = new CloudKnowledgeRetriever({ search })

    await expect(retriever.search('合同条款', ['kb_1'])).resolves.toMatchObject({
      strategy: 'hybrid', generations: [{ generationId: 'generation_current' }],
      evidence: [{ id: 'chunk_a' }, { id: 'chunk_b' }],
    })
    expect(search).toHaveBeenCalledWith({
      query: '合同条款', knowledgeBaseIds: ['kb_1'], limit: 24,
    })
  })

  it('falls back to keyword-only when consent is absent or TokenHub is unavailable', async () => {
    for (const strategy of ['keyword_only_consent', 'keyword_only_provider'] as const) {
      const retriever = new CloudKnowledgeRetriever({ search: vi.fn().mockResolvedValue({
        generationState: 'published', generations: [{ knowledgeBaseId: 'kb_1',
          generationId: 'generation_current', previousGenerationId: null }], strategy,
        embedding: fixedCloudEmbeddingConfiguration,
        keywordCandidates: [candidate('chunk_keyword', 1)], vectorCandidates: [],
        driftProbeRequired: false,
      }) })
      await expect(retriever.search('合同条款', ['kb_1'])).resolves.toMatchObject({
        strategy, evidence: [{ id: 'chunk_keyword' }],
      })
    }
  })

  it('fails closed to keyword candidates and requests a shadow drift probe on metadata drift', async () => {
    const retriever = new CloudKnowledgeRetriever({ search: vi.fn().mockResolvedValue({
      generationState: 'published', generations: [{ knowledgeBaseId: 'kb_1',
        generationId: 'generation_current', previousGenerationId: 'generation_previous' }],
      strategy: 'hybrid',
      embedding: { ...fixedCloudEmbeddingConfiguration, dimensions: 768 },
      keywordCandidates: [candidate('chunk_keyword', 1)],
      vectorCandidates: [candidate('chunk_vector', 1)], driftProbeRequired: true,
    }) })

    await expect(retriever.search('合同条款', ['kb_1'])).resolves.toEqual({
      strategy: 'keyword_only_drift', generations: [{ knowledgeBaseId: 'kb_1',
        generationId: 'generation_current', previousGenerationId: 'generation_previous' }],
      driftProbeRequired: true,
      evidence: [candidate('chunk_keyword', 1)],
    })
  })

  it('rejects unpublished and cross-generation candidates', async () => {
    for (const response of [
      {
        generationState: 'ready', generations: [{ knowledgeBaseId: 'kb_1',
          generationId: 'generation_shadow', previousGenerationId: null }],
        strategy: 'hybrid', embedding: fixedCloudEmbeddingConfiguration,
        keywordCandidates: [], vectorCandidates: [], driftProbeRequired: false,
      },
      {
        generationState: 'published', generations: [{ knowledgeBaseId: 'kb_1',
          generationId: 'generation_current', previousGenerationId: null }],
        strategy: 'hybrid', embedding: fixedCloudEmbeddingConfiguration,
        keywordCandidates: [candidate('chunk_shadow', 1, 'generation_shadow')],
        vectorCandidates: [], driftProbeRequired: false,
      },
    ]) {
      const retriever = new CloudKnowledgeRetriever({ search: vi.fn().mockResolvedValue(response) })
      await expect(retriever.search('合同条款', ['kb_1'])).rejects.toMatchObject({
        code: 'INVALID_CLOUD_RETRIEVAL_RESPONSE',
      })
    }
  })

  it('accepts an immutable published generation snapshot across selected bases', async () => {
    const second = { ...candidate('chunk_second', 1, 'generation_second'),
      knowledgeBaseId: 'kb_2' }
    const retriever = new CloudKnowledgeRetriever({ search: vi.fn().mockResolvedValue({
      generationState: 'published', generations: [
        { knowledgeBaseId: 'kb_1', generationId: 'generation_current', previousGenerationId: null },
        { knowledgeBaseId: 'kb_2', generationId: 'generation_second', previousGenerationId: null },
      ], strategy: 'keyword_only_provider', embedding: fixedCloudEmbeddingConfiguration,
      keywordCandidates: [candidate('chunk_first', 1), second], vectorCandidates: [],
      driftProbeRequired: false,
    }) })
    await expect(retriever.search('合同条款', ['kb_1', 'kb_2'])).resolves.toMatchObject({
      evidence: [{ id: 'chunk_first' }, { id: 'chunk_second' }],
    })
  })
})
