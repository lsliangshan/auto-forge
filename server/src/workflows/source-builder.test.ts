import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { zipSync, strToU8 } from 'fflate'
import { buildSourceArchive } from './source-builder.js'

const manifest = {
  schemaVersion: 1, sdkVersion: 1, slug: 'fixture-workflow', name: 'Fixture',
  description: 'Test workflow', version: '1.0.0', categorySlug: 'developer-tools',
  entry: 'dist/index.mjs', targetHosts: ['localhost'], permissions: ['browser.read']
}

function archive(source: string, extra: Record<string, Uint8Array> = {}) {
  return Buffer.from(zipSync({
    'workflow.json': strToU8(JSON.stringify(manifest)),
    'README.md': strToU8('# Fixture'),
    'tsconfig.json': strToU8('{}'),
    'sdk/index.d.ts': strToU8('export interface WorkflowContext {}'),
    'src/index.ts': strToU8(source),
    ...extra
  }))
}

describe('source builder', () => {
  it('builds a valid single entry workflow deterministically', async () => {
    const source = "import type { WorkflowContext } from '@autoforge/workflow-sdk'; export async function run(context: WorkflowContext) { return { ok: true } }"
    const first = await buildSourceArchive(archive(source))
    const second = await buildSourceArchive(archive(source))
    expect(first.manifest.slug).toBe('fixture-workflow')
    expect(first.codeSha256).toBe(createHash('sha256').update(first.code).digest('hex'))
    expect(second.codeSha256).toBe(first.codeSha256)
  })

  it('rejects runtime dependencies and non-whitelisted files', async () => {
    await expect(buildSourceArchive(archive("import lodash from 'lodash'; export async function run() {}"))).rejects.toThrow(/import/i)
    await expect(buildSourceArchive(archive('export async function run() {}', { '../escape': strToU8('x') }))).rejects.toThrow()
  })
})
