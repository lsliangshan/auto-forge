import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  createKnowledgeParser,
  createKnowledgeWorker,
  createWorkerStorageClient,
} from '../../cloudbase/knowledge/worker/knowledge-worker.js'

const claim = (id: string, kind: 'upload' | 'embedding' | 'purge', attempt = 1) => ({
  job: { id, kind, entityId: `${kind}_entity`, leaseToken: `lease_${id}`, attempt },
})

describe('CloudBase knowledge scheduled worker', () => {
  it('ships a directly deployable CommonJS scheduled entry', async () => {
    const [rootEntry, entry, packageJson] = await Promise.all([
      readFile(new URL('../../cloudbase/knowledge/index.js', import.meta.url), 'utf8'),
      readFile(new URL('../../cloudbase/knowledge/worker/index.js', import.meta.url), 'utf8'),
      readFile(new URL('../../cloudbase/knowledge/package.json', import.meta.url), 'utf8'),
    ])
    expect(JSON.parse(packageJson)).toMatchObject({ type: 'commonjs', main: 'index.js' })
    expect(JSON.parse(packageJson).dependencies).not.toEqual(expect.objectContaining({
      'autoforge-knowledge': expect.anything(),
    }))
    expect(rootEntry).toContain("require('./worker/index.js')")
    expect(rootEntry).toContain('exports.main = main')
    expect(entry).toContain("require('../function/knowledge-handler.js')")
    expect(entry).toContain('exports.main = main')
    expect(entry).toContain('createEmbeddingGenerationWorker')
    expect(entry).toContain('maximumChunksPerRun: 2')
    expect(entry).not.toMatch(/\bexport\s+(?:default|async|function|const|let|var|class)/)
  })

  it('reads verified Storage bytes, parses, and commits index readiness atomically', async () => {
    const bytes = Buffer.from('云端合同条款')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const storage = {
      readObject: vi.fn().mockResolvedValue(bytes), deleteObjects: vi.fn(),
    }
    const parser = { parse: vi.fn().mockResolvedValue({
      parserVersion: 'cloud-parser-v1',
      blocks: [{ id: 'block_1', ordinal: 0, kind: 'paragraph', body: '云端合同条款',
        coordinates: { kind: 'txt', lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 6 } }],
      chunks: [{ id: 'chunk_1', blockId: 'block_1', ordinal: 0, body: '云端合同条款',
        coordinates: { kind: 'txt', lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 6 } }],
    }) }
    const rpc = vi.fn()
      .mockResolvedValueOnce(claim('job_upload', 'upload'))
      .mockResolvedValueOnce({
        ownerId: '1', knowledgeBaseId: 'kb_1', documentId: 'document_1',
        versionId: 'version_1', generationId: 'generation_1', objectId: 'object_1',
        storageReference: 'knowledge/1/kb_1/object_1', byteSize: bytes.byteLength,
        sha256, mimeType: 'text/plain', name: 'cloud.txt', versionNumber: 1,
      })
      .mockResolvedValueOnce({ completed: true, generationId: 'generation_1', embeddingJobId: null })
      .mockResolvedValueOnce({ job: null })
      .mockResolvedValueOnce({
        prunedChanges: 0, prunedTombstones: 0, prunedSnapshots: 0,
        prunedGenerations: 0, prunedDispatchPermits: 0,
      })
    const worker = createKnowledgeWorker({
      rpc, storage, parser, workerId: 'worker_1', id: () => 'lease_job_upload',
    })

    await expect(worker.runOnce()).resolves.toEqual({ claimed: 1, completed: 1, failed: 0 })
    expect(storage.readObject).toHaveBeenCalledWith({
      storageReference: 'knowledge/1/kb_1/object_1', byteSize: bytes.byteLength,
      sha256, mimeType: 'text/plain',
    })
    expect(rpc).toHaveBeenNthCalledWith(3, 'autoforge_knowledge_complete_upload_index',
      expect.objectContaining({
        p_worker_id: 'worker_1', p_job_id: 'job_upload',
        p_lease_token: 'lease_job_upload', p_generation_id: 'generation_1',
        p_blocks: expect.any(Array), p_chunks: expect.any(Array),
      }))
    expect(bytes.every(byte => byte === 0)).toBe(true)
  })

  it('deletes the exact Storage set before committing purge metadata', async () => {
    const order: string[] = []
    const rpc = vi.fn().mockImplementation(async (name: string) => {
      order.push(name)
      if (name === 'autoforge_knowledge_claim_job') {
        return order.filter(item => item === name).length === 1 ? claim('job_purge', 'purge') : { job: null }
      }
      if (name === 'autoforge_knowledge_prepare_base_purge') return {
        jobId: 'job_purge', storageReferences: ['knowledge/1/kb_1/a', 'knowledge/1/kb_1/b'],
      }
      if (name === 'autoforge_knowledge_complete_base_purge') return {
        jobId: 'job_purge', completed: true,
      }
      if (name === 'autoforge_knowledge_cleanup_retention') return {
        prunedChanges: 0, prunedTombstones: 0, prunedSnapshots: 0,
        prunedGenerations: 0, prunedDispatchPermits: 0,
      }
      throw new Error(`unexpected rpc ${name}`)
    })
    const storage = {
      readObject: vi.fn(),
      deleteObjects: vi.fn(async () => { order.push('storage.deleteObjects') }),
    }
    const worker = createKnowledgeWorker({
      rpc, storage, parser: { parse: vi.fn() }, workerId: 'worker_1',
      id: () => 'lease_job_purge',
    })

    await expect(worker.runOnce()).resolves.toMatchObject({ completed: 1 })
    expect(order.indexOf('storage.deleteObjects')).toBeGreaterThan(
      order.indexOf('autoforge_knowledge_prepare_base_purge'),
    )
    expect(order.indexOf('storage.deleteObjects')).toBeLessThan(
      order.indexOf('autoforge_knowledge_complete_base_purge'),
    )
  })

  it('wires embedding jobs and bounds every scheduled invocation to eight claims', async () => {
    let claims = 0
    const rpc = vi.fn().mockImplementation(async (name: string) => {
      if (name === 'autoforge_knowledge_claim_job') {
        claims += 1
        return claim(`job_embedding_${claims}`, 'embedding')
      }
      if (name === 'autoforge_knowledge_cleanup_retention') return {
        prunedChanges: 0, prunedTombstones: 0, prunedSnapshots: 0,
        prunedGenerations: 0, prunedDispatchPermits: 0,
      }
      throw new Error(`unexpected rpc ${name}`)
    })
    const embeddingWorker = { run: vi.fn().mockResolvedValue({ state: 'completed', embedded: 1 }) }
    const worker = createKnowledgeWorker({
      rpc, storage: { readObject: vi.fn(), deleteObjects: vi.fn() },
      parser: { parse: vi.fn() }, embeddingWorker, workerId: 'worker_1',
      id: () => `lease_job_embedding_${claims + 1}`,
    })

    await expect(worker.runOnce()).resolves.toEqual({ claimed: 8, completed: 8, failed: 0 })
    expect(claims).toBe(8)
    expect(embeddingWorker.run).toHaveBeenCalledTimes(8)
  })

  it('yields a bounded embedding slice without spending its transient retry budget', async () => {
    let claims = 0
    const rpc = vi.fn().mockImplementation(async (name: string) => {
      if (name === 'autoforge_knowledge_claim_job') {
        claims += 1
        return claims === 1 ? claim('job_embedding', 'embedding') : { job: null }
      }
      if (name === 'autoforge_knowledge_yield_job') return { yielded: true }
      if (name === 'autoforge_knowledge_cleanup_retention') return {
        prunedChanges: 0, prunedTombstones: 0, prunedSnapshots: 0,
        prunedGenerations: 0, prunedDispatchPermits: 0,
      }
      throw new Error(`unexpected rpc ${name}`)
    })
    const worker = createKnowledgeWorker({
      rpc, storage: { readObject: vi.fn(), deleteObjects: vi.fn() },
      parser: { parse: vi.fn() }, workerId: 'worker_1',
      embeddingWorker: { run: vi.fn().mockResolvedValue({ state: 'partial', embedded: 2 }) },
      id: () => 'lease_job_embedding',
    })

    await expect(worker.runOnce()).resolves.toEqual({ claimed: 1, completed: 1, failed: 0 })
    expect(rpc).toHaveBeenCalledWith('autoforge_knowledge_yield_job', {
      p_worker_id: 'worker_1', p_job_id: 'job_embedding',
      p_lease_token: 'lease_job_embedding',
    })
    expect(rpc.mock.calls.some(([name]) => name === 'autoforge_knowledge_complete_job')).toBe(false)
    expect(rpc.mock.calls.filter(([name]) => name === 'autoforge_knowledge_claim_job')).toHaveLength(1)
  })

  it('settles transient and terminal failures with the claimed lease identity', async () => {
    for (const [failure, expectedCode] of [
      [{ code: 'TRANSIENT_FAILURE' }, 'TRANSIENT_FAILURE'],
      [new Error('private parser detail'), 'INTERNAL_ERROR'],
    ] as const) {
      let claims = 0
      const rpc = vi.fn().mockImplementation(async (name: string) => {
        if (name === 'autoforge_knowledge_claim_job') {
          claims += 1
          return claims === 1 ? claim('job_upload', 'upload', 3) : { job: null }
        }
        if (name === 'autoforge_knowledge_get_upload_work') throw failure
        if (name === 'autoforge_knowledge_complete_job') return { completed: true }
        if (name === 'autoforge_knowledge_cleanup_retention') return {
          prunedChanges: 0, prunedTombstones: 0, prunedSnapshots: 0,
          prunedGenerations: 0, prunedDispatchPermits: 0,
        }
        throw new Error(`unexpected rpc ${name}`)
      })
      const worker = createKnowledgeWorker({
        rpc, storage: { readObject: vi.fn(), deleteObjects: vi.fn() },
        parser: { parse: vi.fn() }, workerId: 'worker_1', id: () => 'lease_job_upload',
      })

      await expect(worker.runOnce()).resolves.toEqual({ claimed: 1, completed: 0, failed: 1 })
      expect(rpc).toHaveBeenCalledWith('autoforge_knowledge_complete_job', {
        p_worker_id: 'worker_1', p_job_id: 'job_upload',
        p_lease_token: 'lease_job_upload', p_state: 'failed', p_error_code: expectedCode,
      })
      if (expectedCode === 'TRANSIENT_FAILURE') {
        expect(rpc.mock.calls.filter(([name]) => (
          name === 'autoforge_knowledge_claim_job'
        ))).toHaveLength(1)
      }
    }
  })

  it('settles a never-resolving parser before its lease expires and returns from runOnce', async () => {
    vi.useFakeTimers()
    try {
      const bytes = Buffer.from('bounded parser source')
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      let claims = 0
      const rpc = vi.fn().mockImplementation(async (name: string) => {
        if (name === 'autoforge_knowledge_claim_job') {
          claims += 1
          return claims === 1 ? claim('job_upload', 'upload') : { job: null }
        }
        if (name === 'autoforge_knowledge_get_upload_work') return {
          ownerId: '1', knowledgeBaseId: 'kb_1', documentId: 'document_1',
          versionId: 'version_1', generationId: 'generation_1', objectId: 'object_1',
          storageReference: 'knowledge/1/kb_1/object_1', byteSize: bytes.byteLength,
          sha256, mimeType: 'text/plain', name: 'cloud.txt', versionNumber: 1,
        }
        if (name === 'autoforge_knowledge_complete_job') return { completed: true }
        if (name === 'autoforge_knowledge_cleanup_retention') return {
          prunedChanges: 0, prunedTombstones: 0, prunedSnapshots: 0,
          prunedGenerations: 0, prunedDispatchPermits: 0,
        }
        throw new Error(`unexpected rpc ${name}`)
      })
      let parserSignal: AbortSignal | undefined
      const worker = createKnowledgeWorker({
        rpc,
        storage: { readObject: vi.fn().mockResolvedValue(bytes), deleteObjects: vi.fn() },
        parser: { parse: vi.fn(({ signal }: { signal?: AbortSignal }) => {
          parserSignal = signal
          return new Promise<never>(() => undefined)
        }) },
        parserTimeoutMs: 50,
        workerId: 'worker_1', id: () => 'lease_job_upload',
      })

      const run = worker.runOnce()
      const bounded = Promise.race([
        run,
        new Promise<'unsettled'>(resolve => setTimeout(() => resolve('unsettled'), 60)),
      ])
      await vi.advanceTimersByTimeAsync(60)

      await expect(bounded).resolves.toEqual({ claimed: 1, completed: 0, failed: 1 })
      expect(parserSignal?.aborted).toBe(true)
      expect(bytes.every(byte => byte === 0)).toBe(true)
      expect(rpc).toHaveBeenCalledWith('autoforge_knowledge_complete_job', {
        p_worker_id: 'worker_1', p_job_id: 'job_upload',
        p_lease_token: 'lease_job_upload', p_state: 'failed',
        p_error_code: 'TRANSIENT_FAILURE',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('parses bounded text into stable worker blocks and chunks', async () => {
    const parser = createKnowledgeParser()
    const input = {
      bytes: Buffer.from('第一条\n\n第二条'), mimeType: 'text/plain', versionId: 'version_1',
    }
    const first = await parser.parse(input)
    const second = await parser.parse(input)
    expect(first).toEqual(second)
    expect(first.parserVersion).toBe('autoforge-cloud-parser-v1')
    expect(first.blocks.map(({ ordinal, body }) => ({ ordinal, body }))).toEqual([
      { ordinal: 0, body: '第一条' }, { ordinal: 1, body: '第二条' },
    ])
    expect(first.chunks.map(({ ordinal, body }) => ({ ordinal, body }))).toEqual([
      { ordinal: 0, body: '第一条' }, { ordinal: 1, body: '第二条' },
    ])
  })

  it('aborts a never-settling private Storage read at its deadline', async () => {
    vi.useFakeTimers()
    try {
      let signal: AbortSignal | undefined
      const storage = createWorkerStorageClient({
        baseUrl: 'https://pg-storage.example/v1/storage', serviceKey: 'server-only',
        timeoutMs: 50,
        fetchImpl: vi.fn((_url: string, init: { signal: AbortSignal }) => {
          signal = init.signal
          return new Promise<never>(() => undefined)
        }),
      })
      const read = storage.readObject({
        storageReference: 'knowledge/1/kb_1/object_1', byteSize: 4,
        sha256: 'a'.repeat(64), mimeType: 'text/plain',
      })
      const rejected = expect(read).rejects.toEqual({ code: 'TRANSIENT_FAILURE' })
      await vi.advanceTimersByTimeAsync(50)
      await rejected
      expect(signal?.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
