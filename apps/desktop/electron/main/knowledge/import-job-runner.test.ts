import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ImportJobRunner } from './import-job-runner.js'
import { memoryKnowledgeStore, parsedText } from './knowledge-test-support.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

function seedJob(database: ReturnType<typeof memoryKnowledgeStore>['database'], input: {
  activeText?: string
  generation: number
  token: string
}) {
  database.prepare('INSERT INTO knowledge_bases(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('base', '资料', 1, 1)
  database.prepare(`INSERT INTO documents(
    id, knowledge_base_id, name, mime_type, active_version_id, created_at, updated_at,
    lifecycle_status, publication_generation, recycled_at
  ) VALUES (?, ?, ?, ?, NULL, ?, ?, 'queued', ?, NULL)`).run('doc', 'base', '合同.txt', 'text/plain', 1, 1, input.generation)
  if (input.activeText) {
    database.prepare(`INSERT INTO document_versions(
      id, document_id, version_number, status, content_hash, object_id, created_at,
      publication_generation, name, mime_type
    ) VALUES ('old', 'doc', 1, 'ready', 'old-hash', '00000000000000000000000000000001',
      1, 1, '合同.txt', 'text/plain')`).run()
    database.prepare("UPDATE documents SET active_version_id = 'old', lifecycle_status = 'ready' WHERE id = 'doc'").run()
    database.prepare(`INSERT INTO knowledge_blocks(id, version_id, ordinal, kind, text, coordinates_json)
      VALUES ('old-block', 'old', 0, 'txt', ?, '{"kind":"txt","lineStart":1,"lineEnd":1,"charStart":0,"charEnd":3}')`).run(input.activeText)
    database.prepare(`INSERT INTO kb_chunks(id, knowledge_base_id, document_id, version_id, block_id, ordinal, body, coordinates_json)
      VALUES ('old-chunk', 'base', 'doc', 'old', 'old-block', 0, ?, '{"kind":"txt","lineStart":1,"lineEnd":1,"charStart":0,"charEnd":3}')`).run(input.activeText)
  }
  database.prepare(`INSERT INTO document_versions(
    id, document_id, version_number, status, content_hash, object_id, created_at,
    publication_generation, name, mime_type
  ) VALUES ('new', 'doc', ?, 'staging', 'new-hash', '00000000000000000000000000000002',
    2, ?, '合同.txt', 'text/plain')`).run(input.activeText ? 2 : 1, input.generation)
  database.prepare(`INSERT INTO knowledge_import_jobs(
    id, document_id, version_id, generation, publication_token, status, attempt_count, created_at, updated_at
  ) VALUES ('job', 'doc', 'new', ?, ?, 'queued', 0, 2, 2)`).run(input.generation, input.token)
}

describe('knowledge import job runner', () => {
  it('does not recover running jobs after its owner epoch is already stale', async () => {
    const memory = memoryKnowledgeStore()
    await memory.objects.put(Buffer.from('source'))
    seedJob(memory.database, { generation: 1, token: 'token-1' })
    memory.database.prepare("UPDATE knowledge_import_jobs SET status = 'running' WHERE id = 'job'").run()
    const runner = new ImportJobRunner({
      database: memory.database,
      objects: memory.objects,
      parser: { parse: async () => parsedText('unused'), terminateAll: async () => undefined },
      ownerEpoch: 1,
      isCurrentOwnerEpoch: () => false,
      token: randomUUID,
    })

    await runner.recoverAndRun()

    expect(memory.database.prepare('SELECT status FROM knowledge_import_jobs').get())
      .toEqual({ status: 'running' })
  })

  it('recovers a queued job and publishes blocks through generation/token CAS', async () => {
    // Catches restart recovery that leaves durable queued work inert.
    const memory = memoryKnowledgeStore()
    await memory.objects.put(Buffer.from('old'))
    await memory.objects.put(Buffer.from('合同条款'))
    seedJob(memory.database, { generation: 1, token: 'token-1' })
    const runner = new ImportJobRunner({
      database: memory.database,
      objects: memory.objects,
      parser: { parse: async () => parsedText('合同条款'), terminateAll: async () => undefined },
      ownerEpoch: 4,
      isCurrentOwnerEpoch: epoch => epoch === 4,
      token: randomUUID,
    })

    await runner.recoverAndRun()

    expect(memory.database.prepare('SELECT active_version_id, lifecycle_status FROM documents').get())
      .toEqual({ active_version_id: 'new', lifecycle_status: 'ready' })
    expect(memory.database.prepare('SELECT status FROM document_versions WHERE id = ?').get('new'))
      .toEqual({ status: 'ready' })
    expect(memory.database.prepare('SELECT status FROM knowledge_import_jobs').get())
      .toEqual({ status: 'completed' })
  })

  it('retains the prior ready generation when parsing fails or a newer generation wins', async () => {
    // Catches failed or stale replacements that replace the searchable ready version.
    for (const mode of ['failed', 'stale'] as const) {
      const memory = memoryKnowledgeStore()
      await memory.objects.put(Buffer.from('old'))
      await memory.objects.put(Buffer.from('new'))
      seedJob(memory.database, { activeText: '旧版', generation: 2, token: 'token-2' })
      if (mode === 'stale') {
        memory.database.prepare('UPDATE documents SET publication_generation = 3 WHERE id = ?').run('doc')
      }
      const onDocumentChanged = vi.fn()
      const runner = new ImportJobRunner({
        database: memory.database,
        objects: memory.objects,
        parser: {
          parse: async () => {
            if (mode === 'failed') throw new Error('parse failed')
            return parsedText('新版')
          },
          terminateAll: async () => undefined,
        },
        ownerEpoch: 1,
        isCurrentOwnerEpoch: () => true,
        token: randomUUID,
        onDocumentChanged,
      })

      await runner.recoverAndRun()

      expect(memory.database.prepare('SELECT active_version_id FROM documents').get())
        .toEqual({ active_version_id: 'old' })
      expect(memory.database.prepare('SELECT name, mime_type FROM documents').get())
        .toEqual({ name: '合同.txt', mime_type: 'text/plain' })
      expect(memory.database.prepare('SELECT status FROM document_versions WHERE id = ?').get('old'))
        .toEqual({ status: 'ready' })
      expect(memory.database.prepare('SELECT body FROM kb_chunks').all()).toEqual([{ body: '旧版' }])
      expect(onDocumentChanged).toHaveBeenCalledWith('doc')
    }
  })

  it('publishes staged version metadata only with the winning generation', async () => {
    const memory = memoryKnowledgeStore()
    await memory.objects.put(Buffer.from('old'))
    await memory.objects.put(Buffer.from('new'))
    seedJob(memory.database, { activeText: '旧版', generation: 2, token: 'token-2' })
    memory.database.prepare(`UPDATE document_versions
      SET name = '新版.pdf', mime_type = 'application/pdf' WHERE id = 'new'`).run()
    const runner = new ImportJobRunner({
      database: memory.database,
      objects: memory.objects,
      parser: { parse: async () => parsedText('新版'), terminateAll: async () => undefined },
      ownerEpoch: 1,
      isCurrentOwnerEpoch: () => true,
      token: randomUUID,
    })

    await runner.recoverAndRun()

    expect(memory.database.prepare('SELECT name, mime_type, active_version_id FROM documents').get())
      .toEqual({ name: '新版.pdf', mime_type: 'application/pdf', active_version_id: 'new' })
  })

  it('does not publish after the durable publication token changes while parsing', async () => {
    // Catches a late worker publishing under a superseded durable lease token.
    const memory = memoryKnowledgeStore()
    await memory.objects.put(Buffer.from('old'))
    await memory.objects.put(Buffer.from('new'))
    seedJob(memory.database, { activeText: '旧版', generation: 2, token: 'token-2' })
    const parsing = deferred<ReturnType<typeof parsedText>>()
    const started = deferred<void>()
    const runner = new ImportJobRunner({
      database: memory.database,
      objects: memory.objects,
      parser: {
        parse: async () => { started.resolve(); return parsing.promise },
        terminateAll: async () => undefined,
      },
      ownerEpoch: 1,
      isCurrentOwnerEpoch: () => true,
      token: randomUUID,
    })

    const running = runner.recoverAndRun()
    await started.promise
    memory.database.prepare(
      "UPDATE knowledge_import_jobs SET publication_token = 'replacement-token' WHERE id = 'job'",
    ).run()
    parsing.resolve(parsedText('新版'))
    await running

    expect(memory.database.prepare('SELECT active_version_id FROM documents').get())
      .toEqual({ active_version_id: 'old' })
    expect(memory.database.prepare('SELECT body FROM kb_chunks').all()).toEqual([{ body: '旧版' }])
  })

  it('rolls back every publication row when a required CAS update changes zero rows', async () => {
    const memory = memoryKnowledgeStore()
    await memory.objects.put(Buffer.from('old'))
    await memory.objects.put(Buffer.from('new'))
    seedJob(memory.database, { activeText: '旧版', generation: 2, token: 'token-2' })
    const parsing = deferred<ReturnType<typeof parsedText>>()
    const started = deferred<void>()
    const runner = new ImportJobRunner({
      database: memory.database,
      objects: memory.objects,
      parser: {
        parse: async () => { started.resolve(); return parsing.promise },
        terminateAll: async () => undefined,
      },
      ownerEpoch: 1,
      isCurrentOwnerEpoch: () => true,
      token: randomUUID,
    })

    const running = runner.recoverAndRun()
    await started.promise
    memory.database.prepare("UPDATE document_versions SET status = 'failed' WHERE id = 'new'").run()
    parsing.resolve(parsedText('新版'))
    await running

    expect(memory.database.prepare('SELECT active_version_id FROM documents').get())
      .toEqual({ active_version_id: 'old' })
    expect(memory.database.prepare("SELECT body FROM kb_chunks WHERE version_id = 'new'").all()).toEqual([])
    expect(memory.database.prepare('SELECT status FROM knowledge_import_jobs').get())
      .toEqual({ status: 'failed' })
  })
})
