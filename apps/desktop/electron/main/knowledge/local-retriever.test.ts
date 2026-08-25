import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SafeStoragePort } from '../security/secret-store.js'
import { openUserKnowledgeDatabase } from './encrypted-database.js'
import { LocalKnowledgeRetriever } from './local-retriever.js'

const directories: string[] = []

const safeStorage: SafeStoragePort = {
  isAvailable: async () => true,
  encrypt: async value => Buffer.from(value),
  decrypt: async value => ({ value: value.toString(), shouldReEncrypt: false }),
}

async function createDatabase() {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'autoforge-local-retriever-'))
  directories.push(rootDirectory)
  const opened = await openUserKnowledgeDatabase({ rootDirectory, userId: 'alice', safeStorage })
  opened.database.exec(`
    INSERT INTO knowledge_bases (id, name, created_at, updated_at) VALUES
      ('kb_selected', 'Selected', 1, 1),
      ('kb_other', 'Other', 1, 1);
    INSERT INTO documents (id, knowledge_base_id, name, mime_type, active_version_id, status, created_at, updated_at) VALUES
      ('doc_ready', 'kb_selected', 'ready.txt', 'text/plain', NULL, 'ready', 1, 1),
      ('doc_staging', 'kb_selected', 'staging.txt', 'text/plain', NULL, 'processing', 1, 1),
      ('doc_other', 'kb_other', 'other.txt', 'text/plain', NULL, 'ready', 1, 1);
    INSERT INTO document_versions (id, document_id, version_number, status, content_hash, created_at) VALUES
      ('version_ready', 'doc_ready', 1, 'ready', 'hash-ready', 1),
      ('version_staging', 'doc_staging', 1, 'staging', 'hash-staging', 1),
      ('version_other', 'doc_other', 1, 'ready', 'hash-other', 1);
    UPDATE documents SET active_version_id = 'version_ready' WHERE id = 'doc_ready';
    UPDATE documents SET active_version_id = 'version_other' WHERE id = 'doc_other';
    INSERT INTO knowledge_blocks (id, version_id, ordinal, kind, text, coordinates_json) VALUES
      ('block_ready', 'version_ready', 0, 'txt', '北京政务服务大厅', '{"kind":"txt","lineStart":1,"lineEnd":1,"charStart":0,"charEnd":8}'),
      ('block_staging', 'version_staging', 0, 'txt', '北京政务未发布', '{"kind":"txt","lineStart":1,"lineEnd":1,"charStart":0,"charEnd":8}'),
      ('block_other', 'version_other', 0, 'txt', '北京政务其他库', '{"kind":"txt","lineStart":1,"lineEnd":1,"charStart":0,"charEnd":7}');
    INSERT INTO kb_chunks (id, knowledge_base_id, document_id, version_id, block_id, ordinal, body, coordinates_json) VALUES
      ('chunk_ready', 'kb_selected', 'doc_ready', 'version_ready', 'block_ready', 0, '北京政务服务大厅', '{"kind":"txt","lineStart":1,"lineEnd":1,"charStart":0,"charEnd":8}'),
      ('chunk_staging', 'kb_selected', 'doc_staging', 'version_staging', 'block_staging', 0, '北京政务未发布', '{"kind":"txt","lineStart":1,"lineEnd":1,"charStart":0,"charEnd":8}'),
      ('chunk_other', 'kb_other', 'doc_other', 'version_other', 'block_other', 0, '北京政务其他库', '{"kind":"txt","lineStart":1,"lineEnd":1,"charStart":0,"charEnd":7}');
  `)
  return opened
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('LocalKnowledgeRetriever', () => {
  it('asks for detail for one character and bounds two-character fallback to selected ready versions', async () => {
    const opened = await createDatabase()
    const retriever = new LocalKnowledgeRetriever(opened.database)

    await expect(retriever.search(['kb_selected'], '北')).resolves.toEqual({
      kind: 'ask_for_detail',
      results: [],
    })
    const outcome = await retriever.search(['kb_selected'], '北京')
    expect(outcome.kind).toBe('results')
    expect(outcome.results.map(result => result.evidenceId)).toEqual(['chunk_ready'])
    expect(outcome.results[0]?.citation).toEqual({
      evidenceId: 'chunk_ready', documentId: 'doc_ready', versionId: 'version_ready',
      kind: 'txt', startLine: 1, endLine: 1, startColumn: 0, endColumn: 8,
    })
    opened.close()
  })

  it('uses a safely quoted literal trigram query for three or more characters', async () => {
    const opened = await createDatabase()
    const retriever = new LocalKnowledgeRetriever(opened.database)

    const matched = await retriever.search(['kb_selected'], '北京政务')
    expect(matched.results.map(result => result.evidenceId)).toEqual(['chunk_ready'])
    await expect(retriever.search(['kb_selected'], '" OR 北京政务 NOT "'))
      .resolves.toEqual({ kind: 'results', results: [] })
    expect((await retriever.search([], '北京政务')).results).toEqual([])
    opened.close()
  })
})
