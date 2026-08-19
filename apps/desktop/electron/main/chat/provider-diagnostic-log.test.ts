import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProviderDiagnosticLog } from './provider-diagnostic-log.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ProviderDiagnosticLog', () => {
  it('persists only bounded provider diagnostic fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-provider-diagnostic-'))
    roots.push(root)
    const log = new ProviderDiagnosticLog(root, () => new Date('2026-08-19T09:00:00.000Z'))

    log.forProvider('openrouter')({
      operation: 'image',
      status: 400,
      code: 'invalid_request',
      error_type: 'invalid_request',
      raw: 'must-not-be-written',
    } as never)
    await log.flush()

    const contents = await readFile(join(root, 'model-provider.jsonl'), 'utf8')
    expect(JSON.parse(contents)).toEqual({
      occurredAt: '2026-08-19T09:00:00.000Z',
      provider: 'openrouter',
      operation: 'image',
      status: 400,
      code: 'invalid_request',
      error_type: 'invalid_request',
    })
    expect(contents).not.toContain('must-not-be-written')
  })

  it('restarts the single log before an entry would exceed 512 KiB', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-provider-diagnostic-'))
    roots.push(root)
    await writeFile(join(root, 'model-provider.jsonl'), 'x'.repeat(512 * 1024))
    const log = new ProviderDiagnosticLog(root, () => new Date('2026-08-19T09:00:00.000Z'))

    log.forProvider('deepseek')({ operation: 'models', status: 503 })
    await log.flush()

    const contents = await readFile(join(root, 'model-provider.jsonl'), 'utf8')
    expect(contents.length).toBeLessThan(512 * 1024)
    expect(JSON.parse(contents)).toMatchObject({ provider: 'deepseek', status: 503 })
  })

  it('never throws file-system failures back to the provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-provider-diagnostic-'))
    roots.push(root)
    const blocked = join(root, 'not-a-directory')
    await writeFile(blocked, 'file')
    const log = new ProviderDiagnosticLog(blocked)

    expect(() => log.forProvider('openrouter')({ operation: 'image', status: 400 })).not.toThrow()
    await expect(log.flush()).resolves.toBeUndefined()
  })
})
