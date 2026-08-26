import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  createKnowledgeHandler,
  createPostgresRpcClient,
  createPostgresStorageClient,
  createTokenHubEmbeddingClient,
} from '../../cloudbase/knowledge/function/knowledge-handler.js'
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  exactCosineRank,
  reciprocalRankFusion,
} from '../../cloudbase/knowledge/function/hybrid-retrieval.js'

const context = { auth: { uid: '2089908515857502208' } }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

function after(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

describe('CloudBase knowledge function', () => {
  const candidate = (chunkId: string, generationId = 'generation_live') => ({
    chunkId, generationId,
    evidence: {
      evidenceId: `evidence_${chunkId}`, knowledgeBaseId: 'kb_1',
      documentId: 'document_1', versionId: 'version_1',
      snippet: `Excerpt ${chunkId}.`, score: 0,
      citation: {
        evidenceId: `evidence_${chunkId}`, documentId: 'document_1', versionId: 'version_1',
        kind: 'markdown', nodeId: 'node_release',
      },
    },
  })

  it('uses the CloudBase CommonJS index.main deployment contract', async () => {
    const packageJson = JSON.parse(await readFile(
      new URL('../../cloudbase/knowledge/function/package.json', import.meta.url), 'utf8',
    ))
    const entry = await readFile(
      new URL('../../cloudbase/knowledge/function/index.js', import.meta.url), 'utf8',
    )
    expect(packageJson.type).toBe('commonjs')
    expect(entry).toContain('exports.main = main')
    expect(entry).not.toMatch(/\bexport\s+(?:default|async|function|const|let|var|class)/)
  })

  it('derives ownership only from trusted context', async () => {
    const rpc = vi.fn().mockResolvedValue({
      mutationId: 'mutation_1', status: 'applied', sequence: 1, revision: 'r1',
    })
    const handler = createKnowledgeHandler({ rpc })
    await handler({
      action: 'pushMutation', mutationId: 'mutation_1', knowledgeBaseId: 'kb_1',
      entityKind: 'document', entityId: 'document_1', operation: 'upsert',
      baseRevision: null, payload: {}, userId: 'attacker', ownerId: 'attacker',
    }, context)

    expect(rpc).toHaveBeenCalledWith('autoforge_knowledge_push_mutation', {
      p_caller_user_id: '2089908515857502208', p_mutation_id: 'mutation_1',
      p_knowledge_base_id: 'kb_1', p_entity_kind: 'document', p_entity_id: 'document_1',
      p_operation: 'upsert', p_base_revision: null, p_payload: {},
    })
  })

  it('rejects missing identity and invalid or oversized business input', async () => {
    const rpc = vi.fn()
    const handler = createKnowledgeHandler({ rpc })
    await expect(handler({ action: 'getEntitlement' }, {})).resolves.toEqual({
      ok: false, error: { code: 'AUTH_REQUIRED' },
    })
    await expect(handler({
      action: 'pullChanges', knowledgeBaseId: 'kb_1', afterSequence: -1, limit: 1001,
    }, context)).resolves.toEqual({ ok: false, error: { code: 'INVALID_INPUT' } })
    await expect(handler({
      action: 'authorizeUpload', requestId: 'upload_1', knowledgeBaseId: 'kb_1',
      documentId: 'document_1', versionId: 'version_1', byteSize: 0, sha256: 'bad',
    }, context)).resolves.toEqual({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('masks server details and keeps service credentials inside the function RPC client', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: vi.fn().mockResolvedValue({ tier: 'member' }),
    })
    const rpc = createPostgresRpcClient({
      baseUrl: 'https://autoforge.example/v1/rdb/rest', serviceKey: 'server-only', fetchImpl,
    })
    await rpc('autoforge_knowledge_get_entitlement', { p_caller_user_id: '1' })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://autoforge.example/v1/rdb/rest/rpc/autoforge_knowledge_get_entitlement',
      expect.objectContaining({ headers: {
        authorization: 'Bearer server-only', 'content-type': 'application/json',
      } }),
    )

    const handler = createKnowledgeHandler({
      rpc: vi.fn().mockRejectedValue(new Error('database password and signed URL')),
    })
    await expect(handler({ action: 'getEntitlement' }, context)).resolves.toEqual({
      ok: false, error: { code: 'INTERNAL_ERROR' },
    })
  })

  it('returns a consumable expiring PG Storage authorization and verifies uploaded bytes', async () => {
    const sha256 = 'a'.repeat(64)
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        uploadTicket: 'ticket_1', storageReference: 'knowledge/1/kb_1/object_1',
        objectId: 'object_1', jobId: 'job_1', expiresAt: '2026-08-26T12:15:00.000Z',
      })
      .mockResolvedValueOnce({
        objectId: 'object_1', storageReference: 'knowledge/1/kb_1/object_1',
        expectedByteSize: 42, expectedSha256: sha256,
      })
      .mockResolvedValueOnce({
        objectId: 'object_1', storageReference: 'knowledge/1/kb_1/object_1', verified: true,
      })
    const storage = {
      createUploadAuthorization: vi.fn().mockResolvedValue({
        url: 'https://pg-storage.example/upload/ticket_1', method: 'PUT',
        headers: { 'content-length': '42', 'x-content-sha256': sha256 },
        expiresAt: '2026-08-26T12:15:00.000Z',
      }),
      statObject: vi.fn().mockResolvedValue({ byteSize: 42, sha256 }),
      deleteObjects: vi.fn(),
    }
    const handler = createKnowledgeHandler({ rpc, storage })

    await expect(handler({
      action: 'authorizeUpload', requestId: 'upload_1', knowledgeBaseId: 'kb_1',
      documentId: 'document_1', versionId: 'version_1', byteSize: 42, sha256,
    }, context)).resolves.toMatchObject({ ok: true, data: {
      uploadTicket: 'ticket_1', uploadAuthorization: {
        url: 'https://pg-storage.example/upload/ticket_1', method: 'PUT',
      },
    } })
    await expect(handler({ action: 'completeUpload', uploadTicket: 'ticket_1' }, context))
      .resolves.toMatchObject({ ok: true, data: { verified: true } })
    expect(storage.statObject).toHaveBeenCalledWith('knowledge/1/kb_1/object_1')
    expect(rpc).toHaveBeenNthCalledWith(3, 'autoforge_knowledge_verify_upload', {
      p_caller_user_id: '2089908515857502208', p_upload_ticket: 'ticket_1',
      p_actual_byte_size: 42, p_actual_sha256: sha256,
    })
  })

  it('deletes private storage bytes before completing orphan cleanup records', async () => {
    const order: string[] = []
    const rpc = vi.fn().mockImplementationOnce(async () => {
      order.push('prepare')
      return { storageReferences: ['knowledge/1/kb_1/object_1'] }
    }).mockImplementationOnce(async () => {
      order.push('complete')
      return { removed: 1 }
    })
    const storage = {
      createUploadAuthorization: vi.fn(), statObject: vi.fn(),
      deleteObjects: vi.fn().mockImplementation(async () => { order.push('storage') }),
    }
    const handler = createKnowledgeHandler({ rpc, storage })

    await expect(handler({
      action: 'cleanupOrphans', requestId: 'cleanup_1', knowledgeBaseId: 'kb_1',
      storageReferences: ['knowledge/1/kb_1/object_1'],
    }, context)).resolves.toEqual({ ok: true, data: { removed: 1 } })
    expect(order).toEqual(['prepare', 'storage', 'complete'])
  })

  it('keeps storage service credentials server-side in the PG Storage adapter', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200, json: vi.fn().mockResolvedValue({
        url: 'https://pg-storage.example/upload/ticket', method: 'PUT', headers: {},
        expiresAt: '2026-08-26T12:15:00.000Z',
        }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 204, json: vi.fn().mockRejectedValue(new Error('empty')),
      })
    const storage = createPostgresStorageClient({
      baseUrl: 'https://pg-storage.example/v1/storage', serviceKey: 'server-only', fetchImpl,
    })
    await storage.createUploadAuthorization({
      uploadTicket: 'ticket_1', storageReference: 'knowledge/1/kb_1/object_1',
      byteSize: 42, sha256: 'a'.repeat(64), expiresAt: '2026-08-26T12:15:00.000Z',
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://pg-storage.example/v1/storage/upload-authorizations',
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer server-only' }) }),
    )
    await expect(storage.deleteObjects(['knowledge/1/kb_1/object_1'])).resolves.toBeUndefined()
  })

  it('pins the TokenHub adapter to the approved model and dimension contract', async () => {
    const vector = Array(1024).fill(0.25)
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: vi.fn().mockResolvedValue({ data: [{ index: 0, embedding: vector }] }),
    })
    const embeddings = createTokenHubEmbeddingClient({
      baseUrl: 'https://tokenhub.example', apiKey: 'server-only', fetchImpl,
    })
    const signal = new AbortController().signal
    const sendDeadlineMs = Date.now() + 30_000

    await expect(embeddings.embed({
      model: EMBEDDING_MODEL, dimensions: 1024, inputs: ['server-approved input'],
      signal, sendDeadlineMs,
    })).resolves.toEqual({ model: EMBEDDING_MODEL, dimensions: 1024, vectors: [vector] })
    expect(fetchImpl).toHaveBeenCalledWith('https://tokenhub.example/v1/embeddings', {
      method: 'POST',
      headers: { authorization: 'Bearer server-only', 'content-type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: ['server-approved input'] }),
      signal,
    })
    await expect(embeddings.embed({
      model: 'caller-model', dimensions: 1536, inputs: ['blocked'],
    })).rejects.toMatchObject({ code: 'TRANSIENT_FAILURE' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('crash-safe adapter refuses an expired SQL send deadline before fetch', async () => {
    const fetchImpl = vi.fn()
    const embeddings = createTokenHubEmbeddingClient({
      baseUrl: 'https://tokenhub.example', apiKey: 'server-only', fetchImpl,
    })

    await expect(embeddings.embed({
      model: EMBEDDING_MODEL,
      dimensions: 1024,
      inputs: ['LATE_DISCLOSURE_SENTINEL'],
      sendDeadlineMs: Date.now() - 1,
    })).rejects.toMatchObject({ code: 'EMBEDDING_CONSENT_REQUIRED' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('restores TokenHub response order before vectors are associated with inputs', async () => {
    const first = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0)
    const second = Array.from({ length: 1024 }, (_, index) => index === 1 ? 1 : 0)
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: vi.fn().mockResolvedValue({ data: [
        { index: 1, embedding: second }, { index: 0, embedding: first },
      ] }),
    })
    const embeddings = createTokenHubEmbeddingClient({
      baseUrl: 'https://tokenhub.example', apiKey: 'server-only', fetchImpl,
    })

    await expect(embeddings.embed({
      model: EMBEDDING_MODEL, dimensions: 1024, inputs: ['first', 'second'],
      signal: new AbortController().signal, sendDeadlineMs: Date.now() + 30_000,
    })).resolves.toMatchObject({ vectors: [first, second] })
  })

  it('rejects an explicitly mismatched TokenHub response model', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: vi.fn().mockResolvedValue({
        model: 'different-embedding-model',
        data: [{ index: 0, embedding: Array(1024).fill(0.25) }],
      }),
    })
    const embeddings = createTokenHubEmbeddingClient({
      baseUrl: 'https://tokenhub.example', apiKey: 'server-only', fetchImpl,
    })

    await expect(embeddings.embed({
      model: EMBEDDING_MODEL, dimensions: 1024, inputs: ['server-approved input'],
      signal: new AbortController().signal, sendDeadlineMs: Date.now() + 30_000,
    })).rejects.toMatchObject({ code: 'EMBEDDING_MODEL_INVALID' })
  })

  it('validates exactly 1024 dimensions and ranks the small-index path by exact cosine', () => {
    const first = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0)
    const second = Array.from({ length: 1024 }, (_, index) => index === 1 ? 1 : 0)
    expect(EMBEDDING_MODEL).toBe('kinfra-text-embedding-0.6b')
    expect(EMBEDDING_DIMENSIONS).toBe(1024)
    expect(exactCosineRank(first, [
      { candidate: candidate('second'), embedding: second },
      { candidate: candidate('first'), embedding: first },
    ], 8).map(({ candidate: item }) => item.chunkId)).toEqual(['first', 'second'])
    expect(() => exactCosineRank([1, 0], [], 8)).toThrow('INVALID_EMBEDDING_DIMENSIONS')
    expect(() => exactCosineRank(first, [
      { candidate: candidate('bad'), embedding: [1, 0] },
    ], 8)).toThrow('INVALID_EMBEDDING_DIMENSIONS')
  })

  it('uses deterministic reciprocal-rank fusion without an external reranker', () => {
    const keyword = [candidate('beta'), candidate('alpha'), candidate('gamma')]
    const vector = [candidate('alpha'), candidate('beta'), candidate('delta')]
    const first = reciprocalRankFusion(keyword, vector, 8)
    const second = reciprocalRankFusion(keyword, vector, 8)

    expect(first).toEqual(second)
    expect(first.map(({ chunkId }: { chunkId: string }) => chunkId))
      .toEqual(['alpha', 'beta', 'delta', 'gamma'])
    expect(first[0].evidence.score).toBeCloseTo((1 / 61) + (1 / 62), 12)
    expect(reciprocalRankFusion(
      [candidate('ä'), candidate('z')], [candidate('z'), candidate('ä')], 8,
    ).map(({ chunkId }: { chunkId: string }) => chunkId)).toEqual(['z', 'ä'])
  })

  it.each(['denied', 'revoked'])('never sends query text for %s embedding consent', async (status) => {
    const embeddings = { embed: vi.fn() }
    const rpc = vi.fn().mockResolvedValue({
      embeddingConsentStatus: status,
      keywordCandidates: [candidate('keyword')],
      vectorRows: [],
    })
    const handler = createKnowledgeHandler({ rpc, embeddings })
    await expect(handler({
      action: 'searchPublished', query: 'query stays out of TokenHub', topK: 8,
      generationSnapshot: [{ knowledgeBaseId: 'kb_1', generationId: 'generation_live' }],
    }, context)).resolves.toMatchObject({ ok: true, data: {
      mode: 'keyword_only', degradationReason: 'consent_unavailable',
      results: [{ generationId: 'generation_live' }],
    } })
    expect(embeddings.embed).not.toHaveBeenCalled()
  })

  it('does not begin a late query embedding send after revocation has returned', async () => {
    const searchPrepared = deferred<void>()
    const releaseSearch = deferred<void>()
    let consent: 'granted' | 'revoked' = 'granted'
    const rpc = vi.fn(async (name: string) => {
      if (name === 'autoforge_knowledge_search_published') {
        searchPrepared.resolve()
        await releaseSearch.promise
        return {
          embeddingConsentStatus: 'granted', vectorEligible: true,
          keywordCandidates: [candidate('keyword')], vectorRows: [],
        }
      }
      if (name === 'autoforge_knowledge_set_embedding_consent') {
        consent = 'revoked'
        return {
          processor: 'tokenhub', processingRegion: 'Guangzhou',
          model: EMBEDDING_MODEL, dimensions: 1024, status: 'revoked',
          retrievalByBase: [{ knowledgeBaseId: 'kb_1', retrievalMode: 'keyword_only' }],
        }
      }
      if (name === 'autoforge_knowledge_begin_embedding_send') {
        if (consent !== 'granted') throw { code: 'EMBEDDING_CONSENT_REQUIRED' }
        return { leaseToken: 'lease_query', consentEpoch: 1 }
      }
      if (name === 'autoforge_knowledge_complete_embedding_send') return { released: true }
      throw new Error(`unexpected ${name}`)
    })
    const embeddings = { embed: vi.fn().mockResolvedValue({
      model: EMBEDDING_MODEL, dimensions: 1024, vectors: [Array(1024).fill(0.25)],
    }) }
    const handler = createKnowledgeHandler({ rpc, embeddings })

    const searching = handler({
      action: 'searchPublished', query: 'QUERY_DISCLOSURE_SENTINEL', topK: 8,
      generationSnapshot: [{ knowledgeBaseId: 'kb_1', generationId: 'generation_live' }],
    }, context)
    await searchPrepared.promise
    await expect(handler({
      action: 'setEmbeddingConsent', requestId: 'revoke_query', status: 'revoked',
    }, context)).resolves.toMatchObject({ ok: true, data: { status: 'revoked' } })
    releaseSearch.resolve()

    await expect(searching).resolves.toMatchObject({ ok: true, data: {
      mode: 'keyword_only', degradationReason: 'consent_unavailable',
    } })
    expect(embeddings.embed).not.toHaveBeenCalled()
  })

  it('does not begin a late chunk embedding send after revocation has returned', async () => {
    const buildPrepared = deferred<void>()
    const releaseBuild = deferred<void>()
    let consent: 'granted' | 'revoked' = 'granted'
    const rpc = vi.fn(async (name: string) => {
      if (name === 'autoforge_knowledge_prepare_embedding_generation') {
        buildPrepared.resolve()
        await releaseBuild.promise
        return {
          consentStatus: 'granted', generationId: 'generation_shadow',
          chunks: [{ chunkId: 'chunk_1', body: 'CHUNK_DISCLOSURE_SENTINEL' }],
        }
      }
      if (name === 'autoforge_knowledge_set_embedding_consent') {
        consent = 'revoked'
        return {
          processor: 'tokenhub', processingRegion: 'Guangzhou',
          model: EMBEDDING_MODEL, dimensions: 1024, status: 'revoked',
          retrievalByBase: [{ knowledgeBaseId: 'kb_1', retrievalMode: 'keyword_only' }],
        }
      }
      if (name === 'autoforge_knowledge_begin_embedding_send') {
        if (consent !== 'granted') throw { code: 'EMBEDDING_CONSENT_REQUIRED' }
        return { leaseToken: 'lease_build', consentEpoch: 1 }
      }
      if (name === 'autoforge_knowledge_complete_embedding_send') return { released: true }
      if (name === 'autoforge_knowledge_fail_embedding_generation') return { failed: true }
      throw new Error(`unexpected ${name}`)
    })
    const embeddings = { embed: vi.fn().mockResolvedValue({
      model: EMBEDDING_MODEL, dimensions: 1024,
      vectors: [Array(1024).fill(0.25), Array(1024).fill(0.25)],
    }) }
    const handler = createKnowledgeHandler({ rpc, embeddings })

    const building = handler({
      action: 'buildEmbeddingGeneration', requestId: 'build_late', knowledgeBaseId: 'kb_1',
      generationId: 'generation_shadow', expectedPublishedGenerationId: 'generation_live',
    }, context)
    await buildPrepared.promise
    await expect(handler({
      action: 'setEmbeddingConsent', requestId: 'revoke_build', status: 'revoked',
    }, context)).resolves.toMatchObject({ ok: true, data: { status: 'revoked' } })
    releaseBuild.resolve()

    await expect(building).resolves.toEqual({
      ok: false, error: { code: 'EMBEDDING_CONSENT_REQUIRED' },
    })
    expect(embeddings.embed).not.toHaveBeenCalled()
  })

  it('crash-safe pre-send CAS blocks an admitted operation revoked before disclosure', async () => {
    const startEntered = deferred<void>()
    const releaseStart = deferred<void>()
    let consent: 'granted' | 'revoked' = 'granted'
    let epoch = 1
    let leaseState: 'admitted' | 'expired' = 'admitted'
    const now = Date.now()
    const rpc = vi.fn(async (name: string) => {
      if (name === 'autoforge_knowledge_search_published') return {
        embeddingConsentStatus: 'granted', vectorEligible: true,
        keywordCandidates: [candidate('keyword')], vectorRows: [],
      }
      if (name === 'autoforge_knowledge_begin_embedding_send') {
        return { leaseToken: 'lease_abandoned', consentEpoch: 1 }
      }
      if (name === 'autoforge_knowledge_start_embedding_send') {
        startEntered.resolve()
        await releaseStart.promise
        if (consent !== 'granted' || epoch !== 1) {
          leaseState = 'expired'
          return { started: false, state: 'expired' }
        }
        return { started: true, state: 'sending', sendDeadlineMs: now + 30_000 }
      }
      if (name === 'autoforge_knowledge_set_embedding_consent') {
        consent = 'revoked'
        epoch += 1
        leaseState = 'expired'
        return {
          processor: 'tokenhub', processingRegion: 'Guangzhou',
          model: EMBEDDING_MODEL, dimensions: 1024, status: 'revoked',
          retrievalByBase: [{ knowledgeBaseId: 'kb_1', retrievalMode: 'keyword_only' }],
        }
      }
      if (name === 'autoforge_knowledge_complete_embedding_send') return { released: true }
      throw new Error(`unexpected ${name}`)
    })
    const embeddings = { embed: vi.fn() }
    const handler = createKnowledgeHandler({ rpc, embeddings, now: () => now })

    const searching = handler({
      action: 'searchPublished', query: 'ABANDONED_QUERY_SENTINEL', topK: 8,
      generationSnapshot: [{ knowledgeBaseId: 'kb_1', generationId: 'generation_live' }],
    }, context)
    await expect(Promise.race([
      startEntered.promise.then(() => true),
      after(100).then(() => false),
    ])).resolves.toBe(true)
    await expect(handler({
      action: 'setEmbeddingConsent', requestId: 'revoke_abandoned', status: 'revoked',
    }, context)).resolves.toMatchObject({ ok: true, data: { status: 'revoked' } })
    releaseStart.resolve()

    await expect(searching).resolves.toMatchObject({ ok: true, data: {
      mode: 'keyword_only', degradationReason: 'consent_unavailable',
    } })
    expect(leaseState).toBe('expired')
    expect(embeddings.embed).not.toHaveBeenCalled()
  })

  it('crash-safe release retries idempotent completion after a lost response', async () => {
    const now = Date.now()
    let releaseCalls = 0
    let leaseState: 'sending' | 'released' = 'sending'
    const rpc = vi.fn(async (name: string) => {
      if (name === 'autoforge_knowledge_search_published') return {
        embeddingConsentStatus: 'granted', vectorEligible: true,
        keywordCandidates: [candidate('keyword')], vectorRows: [],
      }
      if (name === 'autoforge_knowledge_begin_embedding_send') {
        return { leaseToken: 'lease_response_lost', consentEpoch: 1 }
      }
      if (name === 'autoforge_knowledge_start_embedding_send') {
        return { started: true, state: 'sending', sendDeadlineMs: now + 30_000 }
      }
      if (name === 'autoforge_knowledge_complete_embedding_send') {
        releaseCalls += 1
        if (releaseCalls === 1) {
          leaseState = 'released'
          throw { code: 'TRANSIENT_FAILURE' }
        }
        return { released: true, state: leaseState }
      }
      throw new Error(`unexpected ${name}`)
    })
    const embeddings = { embed: vi.fn().mockResolvedValue({
      model: EMBEDDING_MODEL, dimensions: 1024, vectors: [Array(1024).fill(0.25)],
    }) }
    const handler = createKnowledgeHandler({ rpc, embeddings, now: () => now })

    await expect(handler({
      action: 'searchPublished', query: 'release retry', topK: 8,
      generationSnapshot: [{ knowledgeBaseId: 'kb_1', generationId: 'generation_live' }],
    }, context)).resolves.toMatchObject({ ok: true, data: {
      mode: 'hybrid', degradationReason: null,
    } })
    expect(releaseCalls).toBe(2)
    expect(leaseState).toBe('released')
  })

  it('crash-safe discards provider success when completion reports an expired deadline', async () => {
    let now = Date.now()
    const sendDeadlineMs = now + 30_000
    const rpc = vi.fn(async (name: string) => {
      if (name === 'autoforge_knowledge_search_published') return {
        embeddingConsentStatus: 'granted', vectorEligible: true,
        keywordCandidates: [candidate('keyword')],
        vectorRows: [{
          candidate: candidate('VECTOR_RESULT_MUST_BE_DISCARDED'),
          embedding: Array(1024).fill(0.25),
        }],
      }
      if (name === 'autoforge_knowledge_begin_embedding_send') {
        return { leaseToken: 'lease_expired_after_provider', consentEpoch: 1 }
      }
      if (name === 'autoforge_knowledge_start_embedding_send') {
        return { started: true, state: 'sending', sendDeadlineMs }
      }
      if (name === 'autoforge_knowledge_complete_embedding_send') {
        return { released: true, state: 'expired' }
      }
      throw new Error(`unexpected ${name}`)
    })
    const embeddings = { embed: vi.fn().mockImplementation(async () => {
      now = sendDeadlineMs
      return {
        model: EMBEDDING_MODEL, dimensions: 1024,
        vectors: [Array(1024).fill(0.25)],
      }
    }) }
    const handler = createKnowledgeHandler({ rpc, embeddings, now: () => now })

    const result = await handler({
      action: 'searchPublished', query: 'deadline race', topK: 8,
      generationSnapshot: [{ knowledgeBaseId: 'kb_1', generationId: 'generation_live' }],
    }, context)

    expect(result).toMatchObject({ ok: true, data: {
      mode: 'keyword_only', degradationReason: 'provider_unavailable',
      results: [{ chunkId: 'keyword' }],
    } })
    expect(JSON.stringify(result)).not.toContain('VECTOR_RESULT_MUST_BE_DISCARDED')
  })

  it('crash-safe never persists provider success when consent changes before completion', async () => {
    const now = Date.now()
    let consentEpoch = 1
    let persisted = false
    const vector = Array(1024).fill(0.25)
    const rpc = vi.fn(async (name: string) => {
      if (name === 'autoforge_knowledge_prepare_embedding_generation') return {
        consentStatus: 'granted', generationId: 'generation_shadow',
        chunks: [{ chunkId: 'chunk_1', body: 'REVOKED_VECTOR_MUST_NOT_PERSIST' }],
      }
      if (name === 'autoforge_knowledge_begin_embedding_send') {
        return { leaseToken: 'lease_revoked_after_provider', consentEpoch: 1 }
      }
      if (name === 'autoforge_knowledge_start_embedding_send') {
        return { started: true, state: 'sending', sendDeadlineMs: now + 30_000 }
      }
      if (name === 'autoforge_knowledge_complete_embedding_send') {
        return consentEpoch === 1
          ? { released: true, state: 'released' }
          : { released: true, state: 'expired' }
      }
      if (name === 'autoforge_knowledge_complete_embedding_generation') {
        persisted = true
        return { generationId: 'generation_shadow', status: 'ready' }
      }
      if (name === 'autoforge_knowledge_publish_generation') return {
        generationId: 'generation_shadow', previousGenerationId: 'generation_live', sequence: 11,
      }
      if (name === 'autoforge_knowledge_fail_embedding_generation') return { failed: true }
      throw new Error(`unexpected ${name}`)
    })
    const embeddings = { embed: vi.fn().mockImplementation(async () => {
      consentEpoch = 2
      return { model: EMBEDDING_MODEL, dimensions: 1024, vectors: [vector, vector] }
    }) }
    const handler = createKnowledgeHandler({ rpc, embeddings, now: () => now })

    await expect(handler({
      action: 'buildEmbeddingGeneration', requestId: 'build_revoked_after_provider',
      knowledgeBaseId: 'kb_1', generationId: 'generation_shadow',
      expectedPublishedGenerationId: 'generation_live',
    }, context)).resolves.toEqual({
      ok: false, error: { code: 'TRANSIENT_FAILURE' },
    })
    expect(persisted).toBe(false)
    expect(rpc).not.toHaveBeenCalledWith(
      'autoforge_knowledge_complete_embedding_generation', expect.anything(),
    )
    expect(rpc).not.toHaveBeenCalledWith(
      'autoforge_knowledge_publish_generation', expect.anything(),
    )
  })

  it('crash-safe release failure preserves the original provider error', async () => {
    const now = Date.now()
    let releaseCalls = 0
    const rpc = vi.fn(async (name: string) => {
      if (name === 'autoforge_knowledge_search_published') return {
        embeddingConsentStatus: 'granted', vectorEligible: true,
        keywordCandidates: [candidate('keyword')], vectorRows: [],
      }
      if (name === 'autoforge_knowledge_begin_embedding_send') {
        return { leaseToken: 'lease_provider_failure', consentEpoch: 1 }
      }
      if (name === 'autoforge_knowledge_start_embedding_send') {
        return { started: true, state: 'sending', sendDeadlineMs: now + 30_000 }
      }
      if (name === 'autoforge_knowledge_complete_embedding_send') {
        releaseCalls += 1
        throw { code: 'TRANSIENT_FAILURE' }
      }
      throw new Error(`unexpected ${name}`)
    })
    const embeddings = { embed: vi.fn().mockRejectedValue({ code: 'MODEL_DEPRECATED' }) }
    const handler = createKnowledgeHandler({ rpc, embeddings, now: () => now })

    await expect(handler({
      action: 'searchPublished', query: 'provider failure', topK: 8,
      generationSnapshot: [{ knowledgeBaseId: 'kb_1', generationId: 'generation_live' }],
    }, context)).resolves.toMatchObject({ ok: true, data: {
      mode: 'keyword_only', degradationReason: 'model_deprecated',
    } })
    expect(releaseCalls).toBe(2)
  })

  it('crash-safe timeout aborts a send and attempts release', async () => {
    const now = Date.now()
    const rpc = vi.fn(async (name: string) => {
      if (name === 'autoforge_knowledge_search_published') return {
        embeddingConsentStatus: 'granted', vectorEligible: true,
        keywordCandidates: [candidate('keyword')], vectorRows: [],
      }
      if (name === 'autoforge_knowledge_begin_embedding_send') {
        return { leaseToken: 'lease_timeout', consentEpoch: 1 }
      }
      if (name === 'autoforge_knowledge_start_embedding_send') {
        return { started: true, state: 'sending', sendDeadlineMs: now + 30_000 }
      }
      if (name === 'autoforge_knowledge_complete_embedding_send') {
        return { released: true, state: 'released' }
      }
      throw new Error(`unexpected ${name}`)
    })
    let sendSignal: AbortSignal | undefined
    const embeddings = { embed: vi.fn(({ signal }: { signal: AbortSignal }) => {
      sendSignal = signal
      return new Promise(() => undefined)
    }) }
    const handler = createKnowledgeHandler({
      rpc, embeddings, now: () => now, embeddingTimeoutMs: 5,
    })
    const outcome = await Promise.race([
      handler({
        action: 'searchPublished', query: 'timeout', topK: 8,
        generationSnapshot: [{ knowledgeBaseId: 'kb_1', generationId: 'generation_live' }],
      }, context),
      after(100).then(() => ({ ok: false, error: { code: 'TEST_TIMEOUT' } })),
    ])

    expect(outcome).toMatchObject({ ok: true, data: {
      mode: 'keyword_only', degradationReason: 'provider_unavailable',
    } })
    expect(rpc).toHaveBeenCalledWith('autoforge_knowledge_complete_embedding_send', {
      p_caller_user_id: context.auth.uid,
      p_lease_token: 'lease_timeout',
      p_consent_epoch: 1,
    })
    expect(sendSignal?.aborted).toBe(true)
  })

  it('crash-safe revocation expires a stranded sending lease at its fixed deadline', async () => {
    let now = Date.now()
    let consent: 'granted' | 'revoked' = 'granted'
    let epoch = 1
    let leaseState: 'admitted' | 'sending' | 'released' | 'expired' = 'admitted'
    let sendDeadlineMs = 0
    let releaseFailures = 2
    let vectorsDeleted = false
    const deadlineReached = deferred<void>()
    const info = vi.fn()
    const rpc = vi.fn(async (name: string) => {
      if (name === 'autoforge_knowledge_search_published') return {
        embeddingConsentStatus: 'granted', vectorEligible: true,
        keywordCandidates: [candidate('keyword')], vectorRows: [],
      }
      if (name === 'autoforge_knowledge_begin_embedding_send') {
        if (consent !== 'granted') throw { code: 'EMBEDDING_CONSENT_REQUIRED' }
        leaseState = 'admitted'
        return { leaseToken: 'lease_stranded', consentEpoch: epoch }
      }
      if (name === 'autoforge_knowledge_start_embedding_send') {
        if (consent !== 'granted' || epoch !== 1 || leaseState !== 'admitted') {
          leaseState = 'expired'
          return { started: false, state: 'expired' }
        }
        leaseState = 'sending'
        sendDeadlineMs = now + 30_000
        return { started: true, state: 'sending', sendDeadlineMs }
      }
      if (name === 'autoforge_knowledge_complete_embedding_send') {
        if (releaseFailures > 0) {
          releaseFailures -= 1
          throw { code: 'TRANSIENT_FAILURE' }
        }
        leaseState = 'released'
        return { released: true, state: leaseState }
      }
      if (name === 'autoforge_knowledge_set_embedding_consent') {
        consent = 'revoked'
        epoch += 1
        if (leaseState === 'admitted') leaseState = 'expired'
        if (leaseState === 'sending' && now < sendDeadlineMs) await deadlineReached.promise
        if (leaseState === 'sending' && now >= sendDeadlineMs) leaseState = 'expired'
        vectorsDeleted = true
        return {
          processor: 'tokenhub', processingRegion: 'Guangzhou',
          model: EMBEDDING_MODEL, dimensions: 1024, status: 'revoked',
          retrievalByBase: [{ knowledgeBaseId: 'kb_1', retrievalMode: 'keyword_only' }],
        }
      }
      throw new Error(`unexpected ${name}`)
    })
    const embeddings = { embed: vi.fn().mockResolvedValue({
      model: EMBEDDING_MODEL, dimensions: 1024, vectors: [Array(1024).fill(0.25)],
    }) }
    const handler = createKnowledgeHandler({
      rpc, embeddings, logger: { info }, now: () => now,
    })

    await expect(handler({
      action: 'searchPublished', query: 'STRANDED_QUERY_SENTINEL', topK: 8,
      generationSnapshot: [{ knowledgeBaseId: 'kb_1', generationId: 'generation_live' }],
    }, context)).resolves.toMatchObject({ ok: true, data: {
      mode: 'keyword_only', degradationReason: 'provider_unavailable',
    } })
    expect(leaseState).toBe('sending')
    const revoking = handler({
      action: 'setEmbeddingConsent', requestId: 'revoke_stranded', status: 'revoked',
    }, context)
    await Promise.resolve()
    await expect(rpc('autoforge_knowledge_begin_embedding_send', {
      p_caller_user_id: context.auth.uid, p_purpose: 'query',
    })).rejects.toMatchObject({ code: 'EMBEDDING_CONSENT_REQUIRED' })
    expect(vectorsDeleted).toBe(false)
    now = sendDeadlineMs
    deadlineReached.resolve()

    await expect(revoking).resolves.toMatchObject({ ok: true, data: { status: 'revoked' } })
    expect(leaseState).toBe('expired')
    expect(vectorsDeleted).toBe(true)
    const diagnostics = JSON.stringify(info.mock.calls)
    expect(diagnostics).not.toContain('lease_stranded')
    expect(diagnostics).not.toContain('STRANDED_QUERY_SENTINEL')
  })

  it('keeps the last published generation live and degrades on embedding outage or deprecation', async () => {
    const embeddings = {
      embed: vi.fn().mockRejectedValue(Object.assign(new Error('provider payload'), {
        code: 'MODEL_DEPRECATED',
      })),
    }
    const info = vi.fn()
    const rpc = vi.fn(async (name: string) => {
      if (name === 'autoforge_knowledge_search_published') return {
        embeddingConsentStatus: 'granted',
        keywordCandidates: [candidate('published')],
        vectorRows: [{ candidate: candidate('vector'), embedding: Array(1024).fill(0.5) }],
      }
      if (name === 'autoforge_knowledge_begin_embedding_send') {
        return { leaseToken: 'lease_query_outage', consentEpoch: 1 }
      }
      if (name === 'autoforge_knowledge_start_embedding_send') {
        return { started: true, state: 'sending', sendDeadlineMs: Date.now() + 30_000 }
      }
      if (name === 'autoforge_knowledge_complete_embedding_send') {
        return { released: true, state: 'released' }
      }
      throw new Error(`unexpected ${name}`)
    })
    const handler = createKnowledgeHandler({ rpc, embeddings, logger: { info } })
    const query = 'OUTAGE_QUERY_SENTINEL'

    await expect(handler({
      action: 'searchPublished', query, topK: 8,
      generationSnapshot: [{ knowledgeBaseId: 'kb_1', generationId: 'generation_live' }],
    }, context)).resolves.toMatchObject({ ok: true, data: {
      mode: 'keyword_only', degradationReason: 'model_deprecated',
      results: [{ generationId: 'generation_live' }],
    } })
    const diagnostics = JSON.stringify(info.mock.calls)
    expect(diagnostics).not.toContain(query)
    expect(diagnostics).not.toContain('provider payload')
  })

  it('drops any candidate outside the captured published-generation snapshot', async () => {
    const rpc = vi.fn().mockResolvedValue({
      embeddingConsentStatus: 'denied',
      keywordCandidates: [candidate('published'), candidate('shadow', 'generation_shadow')],
      vectorRows: [],
    })
    const handler = createKnowledgeHandler({ rpc, embeddings: { embed: vi.fn() } })

    const result = await handler({
      action: 'searchPublished', query: 'release policy', topK: 8,
      generationSnapshot: [{ knowledgeBaseId: 'kb_1', generationId: 'generation_live' }],
    }, context)
    expect(result).toMatchObject({ ok: true, data: {
      results: [{ generationId: 'generation_live' }],
    } })
    expect(JSON.stringify(result)).not.toContain('generation_shadow')
  })

  it('publishes an embedding shadow only after every vector is validated and the generation is ready', async () => {
    const order: string[] = []
    const vector = Array(1024).fill(0.25)
    const rpc = vi.fn().mockImplementation(async (name: string) => {
      order.push(name)
      if (name === 'autoforge_knowledge_prepare_embedding_generation') return {
        consentStatus: 'granted', generationId: 'generation_shadow',
        chunks: [{ chunkId: 'chunk_1', body: 'INDEX_BODY_SENTINEL' }],
      }
      if (name === 'autoforge_knowledge_begin_embedding_send') {
        return { leaseToken: 'lease_build', consentEpoch: 1 }
      }
      if (name === 'autoforge_knowledge_start_embedding_send') {
        return { started: true, state: 'sending', sendDeadlineMs: Date.now() + 30_000 }
      }
      if (name === 'autoforge_knowledge_complete_embedding_send') {
        return { released: true, state: 'released' }
      }
      if (name === 'autoforge_knowledge_complete_embedding_generation') {
        return { generationId: 'generation_shadow', status: 'ready' }
      }
      if (name === 'autoforge_knowledge_publish_generation') return {
        generationId: 'generation_shadow', previousGenerationId: 'generation_live', sequence: 9,
      }
      throw new Error(`unexpected ${name}`)
    })
    const embeddings = {
      embed: vi.fn().mockImplementation(async () => {
        order.push('tokenhub')
        return { model: EMBEDDING_MODEL, dimensions: 1024, vectors: [vector, vector] }
      }),
    }
    const info = vi.fn()
    const handler = createKnowledgeHandler({ rpc, embeddings, logger: { info } })

    await expect(handler({
      action: 'buildEmbeddingGeneration', requestId: 'build_1', knowledgeBaseId: 'kb_1',
      generationId: 'generation_shadow', expectedPublishedGenerationId: 'generation_live',
    }, context)).resolves.toMatchObject({ ok: true, data: {
      generationId: 'generation_shadow', previousGenerationId: 'generation_live',
    } })
    expect(order).toEqual([
      'autoforge_knowledge_prepare_embedding_generation',
      'autoforge_knowledge_begin_embedding_send',
      'autoforge_knowledge_start_embedding_send', 'tokenhub',
      'autoforge_knowledge_complete_embedding_send',
      'autoforge_knowledge_complete_embedding_generation',
      'autoforge_knowledge_publish_generation',
    ])
    expect(JSON.stringify(info.mock.calls)).not.toContain('INDEX_BODY_SENTINEL')
  })

  it('uses a server-owned probe and leaves the published generation untouched when no drift is detected', async () => {
    const probeVector = Array(1024).fill(0.125)
    const rpc = vi.fn().mockImplementation(async (name: string) => {
      if (name === 'autoforge_knowledge_get_embedding_consent') return {
        status: 'granted',
        retrievalByBase: [{ knowledgeBaseId: 'kb_1', retrievalMode: 'hybrid' }],
      }
      if (name === 'autoforge_knowledge_begin_embedding_send') {
        return { leaseToken: 'lease_drift', consentEpoch: 1 }
      }
      if (name === 'autoforge_knowledge_start_embedding_send') {
        return { started: true, state: 'sending', sendDeadlineMs: Date.now() + 30_000 }
      }
      if (name === 'autoforge_knowledge_complete_embedding_send') {
        return { released: true, state: 'released' }
      }
      if (name === 'autoforge_knowledge_prepare_drift_generation') return {
        drifted: false, publishedGenerationId: 'generation_live',
      }
      throw new Error(`unexpected ${name}`)
    })
    const embeddings = { embed: vi.fn().mockResolvedValue({
      model: EMBEDDING_MODEL, dimensions: 1024, vectors: [probeVector],
    }) }
    const handler = createKnowledgeHandler({ rpc, embeddings })

    await expect(handler({
      action: 'probeEmbeddingDrift', requestId: 'probe_1', knowledgeBaseId: 'kb_1',
      generationId: 'generation_shadow', expectedPublishedGenerationId: 'generation_live',
    }, context)).resolves.toEqual({ ok: true, data: {
      drifted: false, publishedGenerationId: 'generation_live',
    } })
    expect(embeddings.embed).toHaveBeenCalledWith(expect.objectContaining({
      model: EMBEDDING_MODEL, dimensions: 1024,
      inputs: ['autoforge:knowledge:embedding-drift-probe:v1'],
      signal: expect.any(AbortSignal), sendDeadlineMs: expect.any(Number),
    }))
    expect(rpc).not.toHaveBeenCalledWith(
      'autoforge_knowledge_publish_generation', expect.anything(),
    )
  })

  it('fails an invalid or unavailable shadow without replacing the published generation', async () => {
    const rpc = vi.fn().mockImplementation(async (name: string) => {
      if (name === 'autoforge_knowledge_prepare_embedding_generation') return {
        consentStatus: 'granted', generationId: 'generation_shadow',
        chunks: [{ chunkId: 'chunk_1', body: 'body' }],
      }
      if (name === 'autoforge_knowledge_begin_embedding_send') {
        return { leaseToken: 'lease_invalid', consentEpoch: 1 }
      }
      if (name === 'autoforge_knowledge_start_embedding_send') {
        return { started: true, state: 'sending', sendDeadlineMs: Date.now() + 30_000 }
      }
      if (name === 'autoforge_knowledge_complete_embedding_send') {
        return { released: true, state: 'released' }
      }
      if (name === 'autoforge_knowledge_fail_embedding_generation') return { failed: true }
      throw new Error(`unexpected ${name}`)
    })
    const embeddings = {
      embed: vi.fn().mockResolvedValue({
        model: EMBEDDING_MODEL, dimensions: 1536,
        vectors: [Array(1536).fill(0), Array(1536).fill(0)],
      }),
    }
    const handler = createKnowledgeHandler({ rpc, embeddings })

    await expect(handler({
      action: 'buildEmbeddingGeneration', requestId: 'build_1', knowledgeBaseId: 'kb_1',
      generationId: 'generation_shadow', expectedPublishedGenerationId: 'generation_live',
    }, context)).resolves.toEqual({
      ok: false, error: { code: 'EMBEDDING_MODEL_INVALID' },
    })
    expect(rpc).toHaveBeenCalledWith('autoforge_knowledge_fail_embedding_generation', {
      p_caller_user_id: context.auth.uid,
      p_knowledge_base_id: 'kb_1', p_generation_id: 'generation_shadow',
      p_error_code: 'EMBEDDING_MODEL_INVALID',
    })
    expect(rpc).not.toHaveBeenCalledWith(
      'autoforge_knowledge_publish_generation', expect.anything(),
    )
  })

  it('preserves a ready shadow and the publish CAS error when an atomic switch loses its race', async () => {
    const vector = Array(1024).fill(0.25)
    const rpc = vi.fn().mockImplementation(async (name: string) => {
      if (name === 'autoforge_knowledge_prepare_embedding_generation') return {
        consentStatus: 'granted', generationId: 'generation_shadow', chunks: [],
      }
      if (name === 'autoforge_knowledge_begin_embedding_send') {
        return { leaseToken: 'lease_publish_race', consentEpoch: 1 }
      }
      if (name === 'autoforge_knowledge_start_embedding_send') {
        return { started: true, state: 'sending', sendDeadlineMs: Date.now() + 30_000 }
      }
      if (name === 'autoforge_knowledge_complete_embedding_send') {
        return { released: true, state: 'released' }
      }
      if (name === 'autoforge_knowledge_complete_embedding_generation') return {
        generationId: 'generation_shadow', status: 'ready',
      }
      if (name === 'autoforge_knowledge_publish_generation') throw { code: 'CONFLICT' }
      throw new Error(`unexpected ${name}`)
    })
    const handler = createKnowledgeHandler({ rpc, embeddings: {
      embed: vi.fn().mockResolvedValue({
        model: EMBEDDING_MODEL, dimensions: 1024, vectors: [vector],
      }),
    } })

    await expect(handler({
      action: 'buildEmbeddingGeneration', requestId: 'build_race', knowledgeBaseId: 'kb_1',
      generationId: 'generation_shadow', expectedPublishedGenerationId: 'generation_live',
    }, context)).resolves.toEqual({ ok: false, error: { code: 'CONFLICT' } })
    expect(rpc).not.toHaveBeenCalledWith(
      'autoforge_knowledge_fail_embedding_generation', expect.anything(),
    )
  })
})

describe('CloudBase knowledge migration contract', () => {
  it('stores separate embedding consent and revokes vectors without disabling keyword mappings', async () => {
    const sql = await readFile(
      new URL('../../cloudbase/knowledge/migrations/0001_personal_knowledge.sql', import.meta.url),
      'utf8',
    )
    const consent = sql.match(
      /CREATE OR REPLACE FUNCTION public\.autoforge_knowledge_set_embedding_consent[\s\S]*?\n\$\$;/,
    )?.[0]

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.knowledge_embedding_consents')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.knowledge_generation_chunks')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.knowledge_chunk_embeddings')
    expect(sql).toContain("CHECK (dimensions = 1024)")
    expect(sql).toContain('CHECK (array_length(embedding, 1) = 1024)')
    expect(consent).toContain("p_status IN ('granted', 'denied', 'revoked')")
    expect(consent).toContain('DELETE FROM public.knowledge_chunk_embeddings')
    expect(consent).not.toContain('DELETE FROM public.knowledge_generation_chunks')
    expect(consent).toContain("kind, entity_id, state")
    expect(consent).toContain("'embedding_reindex'")
  })

  it('defines the crash-safe finite-state send protocol and bounded revocation', async () => {
    const sql = await readFile(
      new URL('../../cloudbase/knowledge/migrations/0001_personal_knowledge.sql', import.meta.url),
      'utf8',
    )
    const beginSend = sql.match(
      /CREATE OR REPLACE FUNCTION public\.autoforge_knowledge_begin_embedding_send[\s\S]*?\n\$\$;/,
    )?.[0]
    const completeSend = sql.match(
      /CREATE OR REPLACE FUNCTION public\.autoforge_knowledge_complete_embedding_send[\s\S]*?\n\$\$;/,
    )?.[0]
    const startSend = sql.match(
      /CREATE OR REPLACE FUNCTION public\.autoforge_knowledge_start_embedding_send[\s\S]*?\n\$\$;/,
    )?.[0]
    const setConsent = sql.match(
      /CREATE OR REPLACE FUNCTION public\.autoforge_knowledge_set_embedding_consent[\s\S]*?\n\$\$;/,
    )?.[0]
    const cleanup = sql.match(
      /CREATE OR REPLACE FUNCTION public\.autoforge_knowledge_cleanup_retention[\s\S]*?\n\$\$;/,
    )?.[0]

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.knowledge_embedding_send_leases')
    expect(sql).toContain('authorization_epoch bigint NOT NULL DEFAULT 0')
    expect(sql).toContain("state varchar(16) NOT NULL DEFAULT 'admitted'")
    expect(sql).toContain("CHECK (state IN ('admitted', 'sending', 'released', 'expired'))")
    expect(sql).toContain('expires_at timestamptz NOT NULL')
    expect(beginSend).toContain('FOR UPDATE')
    expect(beginSend).toContain("consent.status <> 'granted'")
    expect(beginSend).toContain('consent.authorization_epoch')
    expect(beginSend).toContain('INSERT INTO public.knowledge_embedding_send_leases')
    expect(beginSend).toContain("interval '10 seconds'")
    expect(startSend).toContain('FOR UPDATE')
    expect(startSend).toContain("lease.state <> 'admitted'")
    expect(startSend).toContain('lease.expires_at <= clock_timestamp()')
    expect(startSend).toContain('consent.authorization_epoch <> p_consent_epoch')
    expect(startSend).toContain("SET state = 'sending'")
    expect(startSend).toContain("interval '30 seconds'")
    expect(startSend).toContain("'sendDeadlineMs'")
    expect(completeSend).toMatch(
      /SELECT \* INTO consent FROM public\.knowledge_embedding_consents\s+WHERE owner_id = owner FOR UPDATE;/,
    )
    expect(completeSend).toMatch(
      /SELECT \* INTO lease FROM public\.knowledge_embedding_send_leases\s+WHERE owner_id = owner AND lease_token = p_lease_token\s+AND consent_epoch = p_consent_epoch FOR UPDATE;/,
    )
    expect(completeSend).toContain("RETURN jsonb_build_object('released', false, 'state', 'missing')")
    expect(completeSend).toContain("IF lease.state = 'released' THEN")
    expect(completeSend).toContain("RETURN jsonb_build_object('released', true, 'state', 'released')")
    expect(completeSend).toContain("IF lease.state = 'expired' THEN")
    expect(completeSend).toContain("RETURN jsonb_build_object('released', false, 'state', 'expired')")
    expect(completeSend).toContain("IF lease.state = 'admitted' THEN")
    expect(completeSend).toContain("RETURN jsonb_build_object('released', false, 'state', 'admitted')")
    expect(completeSend).toContain("consent.status <> 'granted'")
    expect(completeSend).toContain('consent.authorization_epoch <> p_consent_epoch')
    expect(completeSend).toContain("AND state = 'sending' AND expires_at > clock_timestamp()")
    expect(completeSend).toContain("SET state = 'expired'")
    expect(completeSend).not.toContain("state IN ('admitted', 'sending')")
    expect(completeSend).not.toContain("lease_state varchar := 'released'")
    expect(completeSend).not.toContain('COALESCE(lease_state')
    expect(setConsent).toContain('authorization_epoch =')
    expect(setConsent).toContain("state = 'admitted'")
    expect(setConsent).toContain("SET state = 'expired'")
    expect(setConsent).toContain('WHILE EXISTS')
    expect(setConsent).toContain("send.state = 'sending'")
    expect(setConsent).toContain('send.expires_at > clock_timestamp()')
    expect(setConsent).toContain('public.knowledge_embedding_send_leases')
    expect(setConsent).toContain('PERFORM pg_sleep')
    expect(cleanup).toContain("state IN ('released', 'expired')")
    expect(cleanup).toContain("interval '7 days'")
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.autoforge_knowledge_begin_embedding_send(varchar, varchar) FROM PUBLIC, anon, authenticated',
    )
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.autoforge_knowledge_start_embedding_send(varchar, varchar, bigint) FROM PUBLIC, anon, authenticated',
    )
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_start_embedding_send(varchar, varchar, bigint) TO service_role',
    )
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_complete_embedding_send(varchar, varchar, bigint) TO service_role',
    )
  })

  it('keeps drift builds isolated and retains the previous published generation for seven days', async () => {
    const sql = await readFile(
      new URL('../../cloudbase/knowledge/migrations/0001_personal_knowledge.sql', import.meta.url),
      'utf8',
    )
    const prepare = sql.match(
      /CREATE OR REPLACE FUNCTION public\.autoforge_knowledge_prepare_embedding_generation[\s\S]*?\n\$\$;/,
    )?.[0]
    const publish = sql.match(
      /CREATE OR REPLACE FUNCTION public\.autoforge_knowledge_publish_generation[\s\S]*?\n\$\$;/,
    )?.[0]
    const generationLifecycle = sql.match(
      /CREATE OR REPLACE FUNCTION public\.autoforge_knowledge_generation_lifecycle[\s\S]*?\n\$\$;/,
    )?.[0]
    const versionLifecycle = sql.match(
      /CREATE OR REPLACE FUNCTION public\.autoforge_knowledge_version_lifecycle[\s\S]*?\n\$\$;/,
    )?.[0]
    const drift = sql.match(
      /CREATE OR REPLACE FUNCTION public\.autoforge_knowledge_prepare_drift_generation[\s\S]*?\n\$\$;/,
    )?.[0]

    expect(prepare).toContain("'staging'")
    expect(prepare).toContain("'kinfra-text-embedding-0.6b'")
    expect(prepare).toContain("'dimensions', 1024")
    expect(prepare).not.toContain("SET status = 'retired'")
    expect(publish).toContain("generation.status <> 'ready'")
    expect(publish).toContain("retain_until = clock_timestamp() + interval '7 days'")
    expect(publish).toContain("SET status = 'published'")
    expect(sql).toContain('autoforge_knowledge_prepare_drift_generation')
    expect(sql).toContain('probe_fingerprint')
    expect(generationLifecycle).toContain(
      "OLD.status = 'staging' AND NEW.status IN ('staging', 'ready', 'failed')",
    )
    expect(versionLifecycle).not.toContain("NEW.status IN ('staging', 'ready', 'failed')")
    expect(drift).toContain('PERFORM public.autoforge_knowledge_require_cloud(owner)')
    expect(drift).toContain(
      'current_published_generation_id IS DISTINCT FROM p_expected_published_generation_id',
    )
    expect(drift).toContain('published_model = p_model')
    expect(drift).toContain('published_configuration = p_configuration')
  })

  it('maps active chunks at publication so denied consent still has keyword retrieval', async () => {
    const sql = await readFile(
      new URL('../../cloudbase/knowledge/migrations/0001_personal_knowledge.sql', import.meta.url),
      'utf8',
    )
    const publish = sql.match(
      /CREATE OR REPLACE FUNCTION public\.autoforge_knowledge_publish_generation[\s\S]*?\n\$\$;/,
    )?.[0]

    expect(publish).toContain('INSERT INTO public.knowledge_generation_chunks')
    expect(publish).toContain('document.active_version_id')
    expect(publish).not.toContain('knowledge_embedding_consents')
    expect(sql).toContain('Backfill published generation keyword mappings')
  })

  it('checks the cloud gate before reading or granting embedding consent', async () => {
    const sql = await readFile(
      new URL('../../cloudbase/knowledge/migrations/0001_personal_knowledge.sql', import.meta.url),
      'utf8',
    )
    const getConsent = sql.match(
      /CREATE OR REPLACE FUNCTION public\.autoforge_knowledge_get_embedding_consent[\s\S]*?\n\$\$;/,
    )?.[0]
    const setConsent = sql.match(
      /CREATE OR REPLACE FUNCTION public\.autoforge_knowledge_set_embedding_consent[\s\S]*?\n\$\$;/,
    )?.[0]

    expect(getConsent).toContain('PERFORM public.autoforge_knowledge_require_cloud(owner)')
    expect(setConsent).toContain("IF p_status = 'granted' THEN")
    expect(setConsent).toContain('PERFORM public.autoforge_knowledge_require_cloud(owner)')
  })

  it('searches only published generation mappings and keeps exact cosine small-index bounded', async () => {
    const sql = await readFile(
      new URL('../../cloudbase/knowledge/migrations/0001_personal_knowledge.sql', import.meta.url),
      'utf8',
    )
    const search = sql.match(
      /CREATE OR REPLACE FUNCTION public\.autoforge_knowledge_search_published[\s\S]*?\n\$\$;/,
    )?.[0]

    expect(search).toContain('published_generation_id = requested.generation_id')
    expect(search).toContain("generation.status = 'published'")
    expect(search).toContain('generation_chunk.generation_id = requested.generation_id')
    expect(search).toContain('p_exact_cosine_max_chunks')
    expect(search).toContain('vector_count <= p_exact_cosine_max_chunks')
    expect(search).not.toMatch(/hnsw/i)
  })
  it('replays a persisted conflict receipt only for the original mutation input', async () => {
    const sql = await readFile(
      new URL('../../cloudbase/knowledge/migrations/0001_personal_knowledge.sql', import.meta.url),
      'utf8',
    )
    const pushMutation = sql.match(
      /CREATE OR REPLACE FUNCTION public\.autoforge_knowledge_push_mutation[\s\S]*?\n\$\$;/,
    )?.[0]

    expect(pushMutation).toBeDefined()
    expect(sql).toContain('input_hash char(32) NOT NULL')
    expect(sql).toContain('response jsonb NOT NULL')
    expect(pushMutation).toContain('SELECT * INTO existing_conflict FROM public.knowledge_conflicts')
    expect(pushMutation).toContain('existing_conflict.input_hash <> fingerprint')
    expect(pushMutation).toContain('RETURN existing_conflict.response')
    expect(pushMutation).toContain('input_hash, response')
  })

  it('reserves orphan cleanup so upload verification and deletion cannot both win', async () => {
    const sql = await readFile(
      new URL('../../cloudbase/knowledge/migrations/0001_personal_knowledge.sql', import.meta.url),
      'utf8',
    )
    const verifyUpload = sql.match(
      /CREATE OR REPLACE FUNCTION public\.autoforge_knowledge_verify_upload[\s\S]*?\n\$\$;/,
    )?.[0]
    const prepareCleanup = sql.match(
      /CREATE OR REPLACE FUNCTION public\.autoforge_knowledge_prepare_orphan_cleanup[\s\S]*?\n\$\$;/,
    )?.[0]
    const completeCleanup = sql.match(
      /CREATE OR REPLACE FUNCTION public\.autoforge_knowledge_complete_orphan_cleanup[\s\S]*?\n\$\$;/,
    )?.[0]

    expect(sql).toContain("'cleanup_reserved'")
    expect(prepareCleanup).toContain("SET state = 'cleanup_reserved'")
    expect(prepareCleanup).toContain('cleanup_request_id = p_request_id')
    expect(prepareCleanup).toContain('RETURNING object.storage_reference')
    expect(prepareCleanup).toContain('RETURN request_row.response')
    expect(verifyUpload).toContain("object.state IN ('authorized', 'uploaded')")
    expect(verifyUpload).toContain("IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT'")
    expect(completeCleanup).toContain("object.state = 'cleanup_reserved'")
    expect(completeCleanup).toContain('object.cleanup_request_id = p_request_id')
    expect(completeCleanup).toContain("SET state = 'deleted'")
  })

  it('rejects cross-document version and block tuples inside one knowledge base', async () => {
    const sql = await readFile(
      new URL('../../cloudbase/knowledge/migrations/0001_personal_knowledge.sql', import.meta.url),
      'utf8',
    )
    const versions = sql.match(
      /CREATE TABLE IF NOT EXISTS public\.knowledge_versions \([\s\S]*?\n\);/,
    )?.[0]
    const blocks = sql.match(
      /CREATE TABLE IF NOT EXISTS public\.knowledge_blocks \([\s\S]*?\n\);/,
    )?.[0]
    const chunks = sql.match(
      /CREATE TABLE IF NOT EXISTS public\.knowledge_chunks \([\s\S]*?\n\);/,
    )?.[0]

    expect(versions).toContain('UNIQUE(owner_id, knowledge_base_id, document_id, id)')
    expect(blocks).toContain('UNIQUE(owner_id, knowledge_base_id, version_id, id)')
    expect(chunks).toContain(
      'FOREIGN KEY(owner_id, knowledge_base_id, document_id, version_id)',
    )
    expect(chunks).toContain(
      'REFERENCES public.knowledge_versions(owner_id, knowledge_base_id, document_id, id)',
    )
    expect(chunks).toContain('FOREIGN KEY(owner_id, knowledge_base_id, version_id, block_id)')
    expect(chunks).toContain(
      'REFERENCES public.knowledge_blocks(owner_id, knowledge_base_id, version_id, id)',
    )
    expect(sql).toContain(
      'FOREIGN KEY(owner_id, knowledge_base_id, id, active_version_id)',
    )
    expect(sql).toContain(
      'REFERENCES public.knowledge_versions(owner_id, knowledge_base_id, document_id, id)',
    )
  })

  it('ships matching versioned migration and rollback artifacts with owner RLS', async () => {
    const featureSql = await readFile(
      new URL('../../cloudbase/knowledge/migrations/0001_personal_knowledge.sql', import.meta.url), 'utf8',
    )
    const versionedSql = await readFile(
      new URL('../../cloudbase/migrations/20260826120000_personal_knowledge.sql', import.meta.url), 'utf8',
    )
    const rollback = await readFile(
      new URL('../../cloudbase/knowledge/migrations/0001_personal_knowledge.rollback.sql', import.meta.url), 'utf8',
    )
    expect(versionedSql).toBe(featureSql)
    for (const table of [
      'knowledge_bases', 'knowledge_objects', 'knowledge_documents', 'knowledge_versions',
      'knowledge_parser_runs', 'knowledge_blocks', 'knowledge_chunks', 'knowledge_index_generations',
      'knowledge_embedding_consents', 'knowledge_embedding_send_leases',
      'knowledge_generation_chunks', 'knowledge_chunk_embeddings',
      'knowledge_jobs', 'knowledge_changes', 'knowledge_tombstones', 'knowledge_conflicts',
      'knowledge_sync_floors', 'knowledge_upload_authorizations', 'knowledge_entitlements',
    ]) {
      expect(featureSql).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`)
      expect(featureSql).toContain(`'${table}'`)
      expect(rollback).toContain(`DROP TABLE IF EXISTS public.${table}`)
    }
    expect(featureSql).toContain("EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY'")
    expect(featureSql).toContain("EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY'")
    expect(featureSql).toContain("owner_id = public.autoforge_knowledge_request_user_id()")
    expect(featureSql).toContain("interval '90 days'")
    expect(featureSql).toContain('CREATE TABLE IF NOT EXISTS public.knowledge_sync_floors')
    expect(featureSql).toContain('autoforge_knowledge_cleanup_retention')
    expect(featureSql).toContain("'kind', 'snapshot'")
    expect(featureSql).toContain("'hasMore'")
    expect(featureSql).toContain('page_last_sequence')
    expect(featureSql).toContain('lease_token')
    expect(featureSql).toContain('lease_expires_at')
    expect(featureSql).toContain('expected_published_generation_id')
    expect(featureSql).toContain('GENERATION_NOT_READY')
    expect(featureSql).toContain("'kind', 'cursor_stale'")
    expect(featureSql).toContain('autoforge_knowledge_version_lifecycle')
    expect(featureSql).toContain('autoforge_knowledge_generation_lifecycle')
    expect(featureSql).toContain('knowledge_changes_immutable')
    expect(featureSql).toContain("error_code = 'LEASE_EXPIRED'")
    expect(featureSql).toContain("p_error_code = 'TRANSIENT_FAILURE'")
    expect(featureSql).toContain('CREATE TABLE IF NOT EXISTS public.knowledge_upload_authorizations')
    expect(featureSql).toContain('autoforge_knowledge_verify_upload')
    expect(featureSql).toContain('verified_at IS NULL')
    expect(featureSql).toContain('conflict_kind varchar(32) NOT NULL')
    expect(featureSql).toContain('input_hash char(32) NOT NULL')
    expect(featureSql).toContain("RAISE EXCEPTION USING MESSAGE = 'CONFLICT'")
    expect(featureSql).toContain('pg_advisory_xact_lock')
    expect(featureSql).toContain('FOREIGN KEY(owner_id, knowledge_base_id)')
    expect(featureSql).toContain('FOREIGN KEY(owner_id, knowledge_base_id, document_id)')
    expect(featureSql).toContain('FOREIGN KEY(owner_id, knowledge_base_id, source_object_id)')
    expect(featureSql).not.toContain('ON ALL SEQUENCES IN SCHEMA public')
    expect(rollback).toContain(
      'REVOKE ALL ON FUNCTION public.autoforge_knowledge_start_embedding_send(varchar, varchar, bigint) FROM service_role',
    )
    expect(rollback).toContain(
      'DROP FUNCTION IF EXISTS public.autoforge_knowledge_start_embedding_send(varchar, varchar, bigint)',
    )
    for (const sequence of [
      'knowledge_changes_sequence_seq', 'knowledge_tombstones_id_seq',
      'knowledge_conflicts_id_seq',
    ]) expect(featureSql).toContain(`ON SEQUENCE public.${sequence} TO service_role`)
    expect(featureSql).not.toMatch(/GRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE)[^;]*\bTO\s+(?:PUBLIC|anon)\b/i)
  })
})
