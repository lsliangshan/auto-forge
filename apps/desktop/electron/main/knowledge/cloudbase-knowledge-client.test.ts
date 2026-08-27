import { describe, expect, it, vi } from 'vitest'
import { CloudBaseKnowledgeClient } from './cloudbase-knowledge-client.js'

describe('CloudBaseKnowledgeClient', () => {
  it('uses only the authenticated CloudBase function boundary and omits caller identity', async () => {
    const callFunction = vi.fn().mockResolvedValue({
      result: {
        ok: true,
        data: {
          mutationId: 'mutation_1',
          status: 'applied',
          sequence: 7,
          revision: 'revision_2',
        },
      },
    })
    const client = new CloudBaseKnowledgeClient({ callFunction })

    await expect(client.pushMutation({
      mutationId: 'mutation_1',
      knowledgeBaseId: 'kb_1',
      entityKind: 'document',
      entityId: 'document_1',
      operation: 'upsert',
      baseRevision: 'revision_1',
      payload: { versionId: 'version_2' },
    })).resolves.toEqual({
      mutationId: 'mutation_1', status: 'applied', sequence: 7, revision: 'revision_2',
    })
    expect(callFunction).toHaveBeenCalledWith({
      name: 'autoforge-knowledge',
      data: {
        action: 'pushMutation',
        mutationId: 'mutation_1',
        knowledgeBaseId: 'kb_1',
        entityKind: 'document',
        entityId: 'document_1',
        operation: 'upsert',
        baseRevision: 'revision_1',
        payload: { versionId: 'version_2' },
      },
    })
    expect(JSON.stringify(callFunction.mock.calls)).not.toMatch(/userId|service.?role|serviceKey|cos/i)
  })

  it('rejects malformed cloud envelopes and exposes only stable retry classifications', async () => {
    const malformed = new CloudBaseKnowledgeClient({
      callFunction: vi.fn().mockResolvedValue({ result: { ok: true, data: { sequence: 'seven' } } }),
    })
    await expect(malformed.pullChanges({ knowledgeBaseId: 'kb_1', afterSequence: 0 }))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR', retryable: false })

    const transient = new CloudBaseKnowledgeClient({
      callFunction: vi.fn().mockResolvedValue({
        result: { ok: false, error: { code: 'TRANSIENT_FAILURE' } },
      }),
    })
    await expect(transient.pullChanges({ knowledgeBaseId: 'kb_1', afterSequence: 0 }))
      .rejects.toMatchObject({ code: 'TRANSIENT_FAILURE', retryable: true })

    const transport = new CloudBaseKnowledgeClient({
      callFunction: vi.fn().mockRejectedValue(new Error('token and URL details')),
    })
    await expect(transport.pullChanges({ knowledgeBaseId: 'kb_1', afterSequence: 0 }))
      .rejects.toMatchObject({ code: 'TRANSIENT_FAILURE', retryable: true })

    const regressed = new CloudBaseKnowledgeClient({
      callFunction: vi.fn().mockResolvedValue({ result: { ok: true, data: {
        kind: 'incremental', nextSequence: 4, changes: [],
      } } }),
    })
    await expect(regressed.pullChanges({ knowledgeBaseId: 'kb_1', afterSequence: 5 }))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR', retryable: false })
  })

  it('keeps the previously published generation when publication fails', async () => {
    const callFunction = vi.fn().mockResolvedValue({
      result: { ok: false, error: { code: 'GENERATION_NOT_READY' } },
    })
    const client = new CloudBaseKnowledgeClient({ callFunction })

    await expect(client.publishGeneration({
      requestId: 'publish_1',
      knowledgeBaseId: 'kb_1',
      generationId: 'generation_staging',
      expectedPublishedGenerationId: 'generation_ready',
    })).rejects.toMatchObject({ code: 'GENERATION_NOT_READY', retryable: false })
  })

  it('validates mediated upload authorization and entitlement responses', async () => {
    const callFunction = vi.fn()
      .mockResolvedValueOnce({ result: { ok: true, data: {
        uploadTicket: 'ticket_1', storageReference: 'knowledge/1/kb_1/object_1', objectId: 'object_1',
        jobId: 'job_1', mimeType: 'text/plain', expiresAt: '2026-08-26T12:15:00.000Z',
        uploadAuthorization: {
          url: 'https://pg-storage.example/upload/ticket_1', method: 'PUT', headers: {},
          expiresAt: '2026-08-26T12:15:00.000Z',
        },
      } } })
      .mockResolvedValueOnce({ result: { ok: true, data: {
        tier: 'member', status: 'active', betaEnabled: true, cloudEnabled: true,
        killSwitchEnabled: false, version: 3, validUntil: '2026-09-26T00:00:00.000Z',
      } } })
    const client = new CloudBaseKnowledgeClient({ callFunction })
    await expect(client.authorizeUpload({
      requestId: 'upload_1', knowledgeBaseId: 'kb_1', documentId: 'document_1',
      versionId: 'version_1', byteSize: 42, sha256: 'a'.repeat(64), mimeType: 'text/plain',
    })).resolves.toMatchObject({ uploadTicket: 'ticket_1', storageReference: 'knowledge/1/kb_1/object_1' })
    await expect(client.getEntitlement()).resolves.toMatchObject({
      tier: 'member', cloudEnabled: true, killSwitchEnabled: false,
    })
    expect(JSON.stringify(callFunction.mock.calls)).not.toMatch(/serviceKey|service.?role|cos/i)
  })

  it('rejects noncanonical inputs and oversized or extra-key responses', async () => {
    const callFunction = vi.fn()
      .mockResolvedValueOnce({ result: { ok: true, data: {
        tier: 'free', status: 'active', betaEnabled: false, cloudEnabled: false,
        killSwitchEnabled: true, version: 1, validUntil: null, secret: 'hidden',
      } } })
      .mockResolvedValueOnce({ result: { ok: true, data: { value: 'x'.repeat(1_048_577) } } })
    const client = new CloudBaseKnowledgeClient({ callFunction })
    await expect(client.beginSync({
      requestId: ' begin', knowledgeBaseId: 'kb_1', name: 'Personal',
      revision: 'r1', generationId: 'g1',
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(callFunction).not.toHaveBeenCalled()
    await expect(client.getEntitlement()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    await expect(client.getEntitlement()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  })

  it('stages a new cloud generation before any publication', async () => {
    const callFunction = vi.fn().mockResolvedValue({ result: { ok: true, data: {
      knowledgeBaseId: 'kb_1', generationId: 'generation_1', status: 'staging',
    } } })
    const client = new CloudBaseKnowledgeClient({ callFunction })
    await expect(client.beginSync({
      requestId: 'begin_1', knowledgeBaseId: 'kb_1', name: 'Personal',
      revision: 'local_1', generationId: 'generation_1',
    })).resolves.toEqual({
      knowledgeBaseId: 'kb_1', generationId: 'generation_1', status: 'staging',
    })
    expect(callFunction).toHaveBeenCalledWith({
      name: 'autoforge-knowledge', data: {
        action: 'beginSync', requestId: 'begin_1', knowledgeBaseId: 'kb_1', name: 'Personal',
        revision: 'local_1', generationId: 'generation_1',
      },
    })
  })

  it('accepts page cursors only when hasMore can advance safely', async () => {
    const callFunction = vi.fn()
      .mockResolvedValueOnce({ result: { ok: true, data: {
        kind: 'incremental', nextSequence: 1000, hasMore: true,
        changes: [{ sequence: 1000, entityKind: 'document', entityId: 'document_1000',
          operation: 'upsert', revision: 'r1000', payload: {} }],
      } } })
      .mockResolvedValueOnce({ result: { ok: true, data: {
        kind: 'incremental', nextSequence: 1000, hasMore: true, changes: [],
      } } })
    const client = new CloudBaseKnowledgeClient({ callFunction })

    await expect(client.pullChanges({ knowledgeBaseId: 'kb_1', afterSequence: 0 }))
      .resolves.toMatchObject({ nextSequence: 1000, hasMore: true })
    await expect(client.pullChanges({ knowledgeBaseId: 'kb_1', afterSequence: 1000 }))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  })

  it('accepts a full snapshot and 512-character storage references', async () => {
    const storageReference = `knowledge/${'s'.repeat(502)}`
    const callFunction = vi.fn()
      .mockResolvedValueOnce({ result: { ok: true, data: {
        kind: 'snapshot', nextSequence: 42,
        changes: [{ sequence: 42, entityKind: 'document', entityId: 'document_1',
          operation: 'upsert', revision: 'r42', payload: {} }],
      } } })
      .mockResolvedValueOnce({ result: { ok: true, data: { removed: 1 } } })
    const client = new CloudBaseKnowledgeClient({ callFunction })

    await expect(client.fullResync({ knowledgeBaseId: 'kb_1' }))
      .resolves.toMatchObject({ kind: 'snapshot', nextSequence: 42 })
    await expect(client.cleanupOrphans({
      requestId: 'cleanup_1', knowledgeBaseId: 'kb_1', storageReferences: [storageReference],
    })).resolves.toEqual({ removed: 1 })
  })

  it('rejects mismatched operation identities and duplicate snapshot entities', async () => {
    const callFunction = vi.fn()
      .mockResolvedValueOnce({ result: { ok: true, data: {
        knowledgeBaseId: 'kb_other', generationId: 'generation_1', status: 'staging',
      } } })
      .mockResolvedValueOnce({ result: { ok: true, data: {
        kind: 'snapshot', nextSequence: 4, changes: [
          { sequence: 4, entityKind: 'document', entityId: 'document_1',
            operation: 'upsert', revision: 'r4', payload: {} },
          { sequence: 4, entityKind: 'document', entityId: 'document_1',
            operation: 'upsert', revision: 'r4', payload: {} },
        ],
      } } })
    const client = new CloudBaseKnowledgeClient({ callFunction })
    await expect(client.beginSync({
      requestId: 'begin_1', knowledgeBaseId: 'kb_1', name: 'Personal',
      revision: 'r1', generationId: 'generation_1',
    })).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    await expect(client.fullResync({ knowledgeBaseId: 'kb_1' }))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  })

  it('completes mediated uploads and reads purge job state without storage credentials', async () => {
    const callFunction = vi.fn()
      .mockResolvedValueOnce({ result: { ok: true, data: {
        objectId: 'object_1', storageReference: 'knowledge/1/kb_1/object_1', verified: true,
      } } })
      .mockResolvedValueOnce({ result: { ok: true, data: {
        jobId: 'job_1', state: 'completed', errorCode: null,
      } } })
    const client = new CloudBaseKnowledgeClient({ callFunction })

    await expect(client.completeUpload({ uploadTicket: 'ticket_1' }))
      .resolves.toMatchObject({ verified: true })
    await expect(client.getJob({ jobId: 'job_1' }))
      .resolves.toEqual({ jobId: 'job_1', state: 'completed', errorCode: null })
    expect(JSON.stringify(callFunction.mock.calls)).not.toMatch(/serviceKey|service.?role|cos/i)
  })
})
