import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LOCAL_EMBEDDING_MODEL,
  LOCAL_EMBEDDING_REVISION,
  LocalModelFileCache,
} from './local-embedding.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('local embedding model cache', () => {
  it('downloads a pinned model file once and serves it from the local cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-model-cache-'))
    temporaryDirectories.push(root)
    const fetchRemote = vi.fn(async () => new Response('model-config', {
      status: 200,
      headers: { 'content-length': '12' },
    }))
    const cache = new LocalModelFileCache(root, fetchRemote, new AbortController().signal)
    const url = `https://huggingface.co/${LOCAL_EMBEDDING_MODEL}/resolve/${LOCAL_EMBEDDING_REVISION}/config.json`

    await expect((await cache.match(url))?.text()).resolves.toBe('model-config')
    await expect((await cache.match(url))?.text()).resolves.toBe('model-config')
    expect(fetchRemote).toHaveBeenCalledTimes(1)
  })

  it('refuses unpinned revisions, foreign hosts, and traversal paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-model-cache-'))
    temporaryDirectories.push(root)
    const fetchRemote = vi.fn(async () => new Response('unexpected'))
    const cache = new LocalModelFileCache(root, fetchRemote, new AbortController().signal)

    await expect(cache.match(`https://huggingface.co/${LOCAL_EMBEDDING_MODEL}/resolve/main/config.json`))
      .resolves.toBeUndefined()
    await expect(cache.match(`https://example.com/${LOCAL_EMBEDDING_MODEL}/resolve/${LOCAL_EMBEDDING_REVISION}/config.json`))
      .resolves.toBeUndefined()
    await expect(cache.match(`https://huggingface.co/${LOCAL_EMBEDDING_MODEL}/resolve/${LOCAL_EMBEDDING_REVISION}/%2e%2e/secret`))
      .resolves.toBeUndefined()
    expect(fetchRemote).not.toHaveBeenCalled()
  })
})
