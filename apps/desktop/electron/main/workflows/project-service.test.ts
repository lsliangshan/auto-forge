import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openAppDatabase } from '../database/client.js'
import { WorkflowProjectService } from './project-service.js'
import { WorkflowRegistry } from './registry.js'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'autoforge-workflow-'))
  temporaryDirectories.push(directory)
  return directory
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'browser.search.baidu',
    version: '1.0.0',
    name: 'Baidu search',
    description: 'Search with Baidu.',
    author: 'AutoForge',
    category: 'search',
    entryPath: 'dist/index.js',
    codeSha256: '0'.repeat(64),
    permissions: [{ capability: 'notification.send', scope: {} }],
    activationExamples: ['Search Baidu'],
    activationNegativeExamples: [],
    timeoutMs: 30_000,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    ...overrides,
  }
}

function writeProject(root: string, value = manifest()): void {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'workflow.json'), `${JSON.stringify(value, null, 2)}\n`)
  writeFileSync(join(root, 'src/index.ts'), "import { defineWorkflow } from '@autoforge/workflow-sdk'\nexport default defineWorkflow({ run: async () => ({ ok: true }) })\n")
}

function openTestServices() {
  const directory = temporaryDirectory()
  const database = openAppDatabase(join(directory, 'autoforge.sqlite'))
  const installs = join(directory, 'installed-workflows')
  const projects = new WorkflowProjectService(database, installs)
  return { directory, database, installs, projects }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('WorkflowProjectService', () => {
  it('rejects a file path that escapes the registered project', async () => {
    const { directory, projects } = openTestServices()
    const root = join(directory, 'project')
    writeProject(root)
    const project = projects.register(root)

    await expect(projects.readFile(project.id, '../secret.txt'))
      .rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' })
  })

  it('rejects an existing symlink that resolves outside the registered project', async () => {
    const { directory, projects } = openTestServices()
    const root = join(directory, 'project')
    writeProject(root)
    writeFileSync(join(directory, 'secret.txt'), 'secret')
    symlinkSync(join(directory, 'secret.txt'), join(root, 'linked-secret.txt'))
    const project = projects.register(root)

    await expect(projects.readFile(project.id, 'linked-secret.txt'))
      .rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' })
  })

  it('reads only UTF-8 editable files up to 2 MiB', async () => {
    const { directory, projects } = openTestServices()
    const root = join(directory, 'project')
    writeProject(root)
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0xc3, 0x28]))
    writeFileSync(join(root, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61))
    const project = projects.register(root)

    await expect(projects.readFile(project.id, 'binary.bin')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(projects.readFile(project.id, 'large.txt')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('marks a project invalid when its manifest is no longer valid', async () => {
    const { directory, database, projects } = openTestServices()
    const root = join(directory, 'project')
    writeProject(root)
    const project = projects.register(root)
    writeFileSync(join(root, 'workflow.json'), JSON.stringify({ id: 'not-a-valid-workflow' }))

    await expect(projects.build(project.id)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(database.workflowProjects.get(project.id)?.status).toBe('invalid')
  })

  it('records a failed build without installing an incomplete artifact', async () => {
    const { directory, database, projects } = openTestServices()
    const root = join(directory, 'project')
    writeProject(root)
    writeFileSync(join(root, 'src/index.ts'), 'export const = broken')
    const project = projects.register(root)

    await expect(projects.build(project.id)).rejects.toThrow()
    expect(database.workflowProjects.get(project.id)?.status).toBe('error')
    await expect(projects.install(project.id)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('builds a manifest-validated ESM entry and installs through an owned version directory', async () => {
    const { directory, database, installs, projects } = openTestServices()
    const root = join(directory, 'project')
    writeProject(root)
    const project = projects.register(root)

    const built = await projects.build(project.id)
    const installed = await projects.install(project.id)
    const installedEntry = join(installed.installPath, 'dist/index.js')
    const installedManifest = JSON.parse(readFileSync(join(installed.installPath, 'workflow.json'), 'utf8')) as { codeSha256: string }

    expect(built.status).toBe('ready')
    expect(readFileSync(installedEntry, 'utf8')).toContain('defineWorkflow')
    expect(installedManifest.codeSha256).toBe(createHash('sha256').update(readFileSync(installedEntry)).digest('hex'))
    expect(installed.installPath).toBe(join(installs, 'browser.search.baidu', '1.0.0'))
    expect(database.workflowFiles.list('browser.search.baidu', '1.0.0')).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'dist/index.js', sha256: installedManifest.codeSha256 }),
    ]))
  })

  it('never overwrites an already installed workflow version', async () => {
    const { directory, projects } = openTestServices()
    const root = join(directory, 'project')
    writeProject(root)
    const project = projects.register(root)
    await projects.build(project.id)
    const installed = await projects.install(project.id)
    const firstEntry = readFileSync(join(installed.installPath, 'dist/index.js'), 'utf8')

    await expect(projects.install(project.id)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(readFileSync(join(installed.installPath, 'dist/index.js'), 'utf8')).toBe(firstEntry)
  })
})

describe('WorkflowRegistry', () => {
  it('disables an installed workflow when a declared file hash changes', async () => {
    const { directory, database, projects } = openTestServices()
    const root = join(directory, 'project')
    writeProject(root)
    const project = projects.register(root)
    await projects.build(project.id)
    const installed = await projects.install(project.id)
    writeFileSync(join(installed.installPath, 'dist/index.js'), 'export default {}\n')
    const registry = new WorkflowRegistry(database, projects)

    await expect(registry.verifyIntegrity('browser.search.baidu', '1.0.0'))
      .resolves.toEqual({ valid: false, disabled: true })
    expect(database.installedWorkflows.get('browser.search.baidu', '1.0.0')?.enabled).toBe(false)
  })

  it('exposes development candidates only in developer mode with a current valid build', async () => {
    const { directory, database, projects } = openTestServices()
    const root = join(directory, 'project')
    writeProject(root)
    const project = projects.register(root)
    const registry = new WorkflowRegistry(database, projects)

    expect(await registry.list({ developerMode: false })).toEqual([])
    expect(await registry.list({ developerMode: true })).toEqual([])

    await projects.build(project.id)
    expect(await registry.list({ developerMode: true })).toEqual([
      expect.objectContaining({ id: 'browser.search.baidu', source: 'development', integrity: 'valid' }),
    ])

    writeFileSync(join(root, 'src/index.ts'), 'export default {}\n')
    expect(await registry.list({ developerMode: true })).toEqual([])
  })
})
