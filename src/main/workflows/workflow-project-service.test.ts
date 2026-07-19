// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from '../database/app-database'
import { WorkflowProjectService } from './workflow-project-service'

let root = ''
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

describe('WorkflowProjectService', () => {
  it('creates and builds the fixed project layout', async () => {
    root = mkdtempSync(join(tmpdir(), 'autoforge-project-')); const db = new AppDatabase(':memory:'); db.initialize()
    const service = new WorkflowProjectService(db)
    const project = await service.create(root, { schemaVersion: 1, sdkVersion: 1, slug: 'fixture', name: 'Fixture', description: 'Fixture workflow', version: '1.0.0', categorySlug: 'developer-tools', entry: 'dist/index.mjs', targetHosts: ['localhost'], permissions: ['browser.read'] })
    const built = await service.build(project.id)
    expect(readFileSync(join(project.path, 'dist/index.mjs'), 'utf8')).toContain('async function run')
    expect(built.codeSha256).toMatch(/^[a-f0-9]{64}$/)
    writeFileSync(join(project.path, 'src/index.ts'), 'not valid {{')
    await expect(service.build(project.id)).rejects.toThrow()
    expect(service.list()[0].status).toBe('ERROR')
    db.close()
  })
})
