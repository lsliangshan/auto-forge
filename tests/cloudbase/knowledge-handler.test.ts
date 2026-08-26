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

    await expect(embeddings.embed({
      model: EMBEDDING_MODEL, dimensions: 1024, inputs: ['server-approved input'],
    })).resolves.toEqual({ model: EMBEDDING_MODEL, dimensions: 1024, vectors: [vector] })
    expect(fetchImpl).toHaveBeenCalledWith('https://tokenhub.example/v1/embeddings', {
      method: 'POST',
      headers: { authorization: 'Bearer server-only', 'content-type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: ['server-approved input'] }),
    })
    await expect(embeddings.embed({
      model: 'caller-model', dimensions: 1536, inputs: ['blocked'],
    })).rejects.toMatchObject({ code: 'TRANSIENT_FAILURE' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
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

  it('keeps the last published generation live and degrades on embedding outage or deprecation', async () => {
    const embeddings = {
      embed: vi.fn().mockRejectedValue(Object.assign(new Error('provider payload'), {
        code: 'MODEL_DEPRECATED',
      })),
    }
    const info = vi.fn()
    const rpc = vi.fn().mockResolvedValue({
      embeddingConsentStatus: 'granted',
      keywordCandidates: [candidate('published')],
      vectorRows: [{ candidate: candidate('vector'), embedding: Array(1024).fill(0.5) }],
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
      'autoforge_knowledge_prepare_embedding_generation', 'tokenhub',
      'autoforge_knowledge_complete_embedding_generation',
      'autoforge_knowledge_publish_generation',
    ])
    expect(JSON.stringify(info.mock.calls)).not.toContain('INDEX_BODY_SENTINEL')
  })

  it('uses a server-owned probe and leaves the published generation untouched when no drift is detected', async () => {
    const probeVector = Array(1024).fill(0.125)
    const rpc = vi.fn().mockImplementation(async (name: string) => {
      if (name === 'autoforge_knowledge_get_embedding_consent') return {
        status: 'granted', retrievalMode: 'hybrid',
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
    expect(embeddings.embed).toHaveBeenCalledWith({
      model: EMBEDDING_MODEL, dimensions: 1024,
      inputs: ['autoforge:knowledge:embedding-drift-probe:v1'],
    })
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
      'knowledge_embedding_consents', 'knowledge_generation_chunks', 'knowledge_chunk_embeddings',
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
    for (const sequence of [
      'knowledge_changes_sequence_seq', 'knowledge_tombstones_id_seq',
      'knowledge_conflicts_id_seq',
    ]) expect(featureSql).toContain(`ON SEQUENCE public.${sequence} TO service_role`)
    expect(featureSql).not.toMatch(/GRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE)[^;]*\bTO\s+(?:PUBLIC|anon)\b/i)
  })
})
