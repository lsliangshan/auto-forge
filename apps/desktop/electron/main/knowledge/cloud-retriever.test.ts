import { describe, expect, it, vi } from 'vitest'
import { CloudKnowledgeError } from './cloudbase-knowledge-client.js'
import {
  CLOUD_EMBEDDING_DIMENSIONS,
  CLOUD_EMBEDDING_MODEL,
  CLOUD_RETRIEVAL_TOP_K,
  CloudRetriever,
  type CloudGenerationSnapshot,
  type CloudHybridRetrievalPort,
} from './cloud-retriever.js'

const evidence = {
  evidenceId: 'evidence_1',
  knowledgeBaseId: 'kb_1',
  documentId: 'document_1',
  versionId: 'version_1',
  snippet: 'Release policy excerpt.',
  score: 0.5,
  citation: {
    documentId: 'document_1', versionId: 'version_1',
    kind: 'markdown' as const, nodeId: 'node_release',
  },
}

function remote(overrides: Partial<CloudHybridRetrievalPort> = {}): CloudHybridRetrievalPort {
  return {
    capturePublishedSnapshot: vi.fn().mockResolvedValue([
      { knowledgeBaseId: 'kb_1', generationId: 'generation_live' },
    ]),
    searchPublished: vi.fn().mockResolvedValue({
      mode: 'hybrid', degradationReason: null,
      results: [{ generationId: 'generation_live', evidence }],
    }),
    ...overrides,
  }
}

describe('CloudRetriever', () => {
  it('pins the exact embedding contract and keeps topK Main-owned', async () => {
    const retrieval = remote()
    const retriever = new CloudRetriever(retrieval)
    const snapshot = await retriever.captureSnapshot(['kb_1'])

    await expect(retriever.search(snapshot, 'release policy')).resolves.toMatchObject({
      mode: 'hybrid', results: [evidence],
    })
    expect(CLOUD_EMBEDDING_MODEL).toBe('kinfra-text-embedding-0.6b')
    expect(CLOUD_EMBEDDING_DIMENSIONS).toBe(1024)
    expect(CLOUD_RETRIEVAL_TOP_K).toBe(8)
    expect(retrieval.searchPublished).toHaveBeenCalledWith({
      query: 'release policy',
      generationSnapshot: [{ knowledgeBaseId: 'kb_1', generationId: 'generation_live' }],
      topK: 8,
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.generations)).toBe(true)
  })

  it('rejects forged snapshots and never surfaces an unpublished generation', async () => {
    const retrieval = remote({
      searchPublished: vi.fn().mockResolvedValue({
        mode: 'hybrid', degradationReason: null,
        results: [{ generationId: 'generation_shadow', evidence }],
      }),
    })
    const retriever = new CloudRetriever(retrieval)
    const captured = await retriever.captureSnapshot(['kb_1'])
    const forged = {
      generations: [{ knowledgeBaseId: 'kb_1', generationId: 'generation_shadow' }],
    } as CloudGenerationSnapshot

    await expect(retriever.search(forged, 'release policy'))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(retriever.search(captured, 'release policy'))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  })

  it('rejects incomplete snapshots and generation-to-base mismatches from the remote boundary', async () => {
    const incomplete = new CloudRetriever(remote({
      capturePublishedSnapshot: vi.fn().mockResolvedValue([]),
    }))
    await expect(incomplete.captureSnapshot(['kb_1']))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR' })

    const mismatched = new CloudRetriever(remote({
      searchPublished: vi.fn().mockResolvedValue({
        mode: 'hybrid', degradationReason: null,
        results: [{ generationId: 'generation_live', evidence: {
          ...evidence, knowledgeBaseId: 'kb_other',
        } }],
      }),
    }))
    const snapshot = await mismatched.captureSnapshot(['kb_1'])
    await expect(mismatched.search(snapshot, 'release policy'))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  })

  it('logs only safe retrieval metrics during keyword-only degradation', async () => {
    const query = 'CONFIDENTIAL_QUERY_SENTINEL'
    const snippet = 'CONFIDENTIAL_CHUNK_SENTINEL'
    const info = vi.fn()
    const retrieval = remote({
      searchPublished: vi.fn().mockResolvedValue({
        mode: 'keyword_only', degradationReason: 'provider_unavailable',
        results: [{
          generationId: 'generation_live',
          evidence: { ...evidence, snippet },
        }],
      }),
    })
    const retriever = new CloudRetriever(retrieval, { info })
    const snapshot = await retriever.captureSnapshot(['kb_1'])

    await expect(retriever.search(snapshot, query)).resolves.toMatchObject({
      mode: 'keyword_only', degradationReason: 'provider_unavailable',
    })
    const diagnostics = JSON.stringify(info.mock.calls)
    expect(diagnostics).not.toContain(query)
    expect(diagnostics).not.toContain(snippet)
    expect(diagnostics).not.toMatch(/filename|path|signed.?url|provider.?payload|secret/i)
  })

  it('fails closed for duplicate, oversized, or malformed Main scope', async () => {
    const retriever = new CloudRetriever(remote())
    await expect(retriever.captureSnapshot(['kb_1', 'kb_1']))
      .rejects.toBeInstanceOf(CloudKnowledgeError)
    await expect(retriever.captureSnapshot(Array.from({ length: 33 }, (_, index) => `kb_${index}`)))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    const snapshot = await retriever.captureSnapshot(['kb_1'])
    await expect(retriever.search(snapshot, ' ')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
