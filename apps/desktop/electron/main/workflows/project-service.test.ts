import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  it('enables only the exact installed workflow version', async () => {
    const { directory, database, projects } = openTestServices()
    const root = join(directory, 'project')
    writeProject(root)
    const project = projects.register(root)
    await projects.build(project.id)
    await projects.install(project.id)
    writeFileSync(join(root, 'workflow.json'), `${JSON.stringify(manifest({ version: '2.0.0' }), null, 2)}\n`)
    projects.register(root)
    await projects.build(project.id)
    await projects.install(project.id)
    const registry = new WorkflowRegistry(database, projects)

    registry.setEnabled('browser.search.baidu', '1.0.0', false)

    expect(database.installedWorkflows.get('browser.search.baidu', '1.0.0')?.enabled).toBe(false)
    expect(database.installedWorkflows.get('browser.search.baidu', '2.0.0')?.enabled).toBe(true)
  })

  it('removes an exact installed version from disk and persistence', async () => {
    const { directory, database, projects } = openTestServices()
    const root = join(directory, 'project')
    writeProject(root)
    const project = projects.register(root)
    await projects.build(project.id)
    const installed = await projects.install(project.id)
    database.permissionGrants.upsert({
      id: 'grant_1', workflowId: 'browser.search.baidu', workflowVersion: '1.0.0',
      capability: 'notification.send', scope: {}, scopeHash: 'a'.repeat(64), createdAt: 1, updatedAt: 1,
    })

    await projects.removeInstalled('browser.search.baidu', '1.0.0')

    expect(existsSync(installed.installPath)).toBe(false)
    expect(database.installedWorkflows.get('browser.search.baidu', '1.0.0')).toBeUndefined()
    expect(database.workflowFiles.list('browser.search.baidu', '1.0.0')).toEqual([])
    expect(database.permissionGrants.get('browser.search.baidu', '1.0.0', 'notification.send', 'a'.repeat(64))).toBeUndefined()
  })

  it('restores the quarantined install when removal persistence fails', async () => {
    const { directory, database, installs, projects } = openTestServices()
    const root = join(directory, 'project')
    writeProject(root)
    const project = projects.register(root)
    await projects.build(project.id)
    const installed = await projects.install(project.id)
    const failing = new WorkflowProjectService({
      workflowProjects: database.workflowProjects,
      installedWorkflows: { ...database.installedWorkflows, delete: () => { throw new Error('database unavailable') } },
      workflowFiles: database.workflowFiles,
    }, installs)

    await expect(failing.removeInstalled('browser.search.baidu', '1.0.0')).rejects.toThrow('database unavailable')
    expect(existsSync(installed.installPath)).toBe(true)
    expect(database.installedWorkflows.get('browser.search.baidu', '1.0.0')).toBeDefined()
  })

  it('reports committed removal as success and retries an owned quarantine later', async () => {
    const directory = temporaryDirectory()
    const database = openAppDatabase(join(directory, 'autoforge.sqlite'))
    const installs = join(directory, 'installed-workflows')
    let failCleanup = true
    const projects = new WorkflowProjectService(database, installs, {
      removeQuarantine: async (path) => {
        if (failCleanup) { failCleanup = false; throw new Error('filesystem busy') }
        rmSync(path, { recursive: true, force: true })
      },
    })
    const root = join(directory, 'project')
    writeProject(root)
    const project = projects.register(root)
    await projects.build(project.id)
    await projects.install(project.id)

    await expect(projects.removeInstalled('browser.search.baidu', '1.0.0')).resolves.toBeUndefined()
    expect(database.installedWorkflows.get('browser.search.baidu', '1.0.0')).toBeUndefined()
    expect(readdirSync(join(installs, 'browser.search.baidu')).some((name) => name.startsWith('.autoforge-remove-owned-'))).toBe(true)

    await projects.cleanupOwnedQuarantines()
    expect(readdirSync(join(installs, 'browser.search.baidu'))).toEqual([])
  })

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

  it('rejects a dangling final symlink instead of writing through it outside the project', async () => {
    const { directory, projects } = openTestServices()
    const root = join(directory, 'project')
    const outside = join(directory, 'outside.txt')
    writeProject(root)
    const project = projects.register(root)
    symlinkSync(outside, join(root, 'draft.ts'))

    await expect(projects.write(project.id, 'draft.ts', 'outside')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' })
    expect(existsSync(outside)).toBe(false)
  })

  it('rejects registration when the manifest is an external symlink', () => {
    const { directory, projects } = openTestServices()
    const root = join(directory, 'project')
    const outsideManifest = join(directory, 'workflow.json')
    writeProject(root)
    writeFileSync(outsideManifest, JSON.stringify(manifest()))
    rmSync(join(root, 'workflow.json'))
    symlinkSync(outsideManifest, join(root, 'workflow.json'))

    expect(() => projects.register(root)).toThrow(expect.objectContaining({ code: 'PATH_OUTSIDE_PROJECT' }))
  })

  it('rejects a build when the source entry is an external symlink', async () => {
    const { directory, projects } = openTestServices()
    const root = join(directory, 'project')
    const outsideSource = join(directory, 'index.ts')
    writeProject(root)
    writeFileSync(outsideSource, 'export default {}\n')
    const project = projects.register(root)
    rmSync(join(root, 'src/index.ts'))
    symlinkSync(outsideSource, join(root, 'src/index.ts'))

    await expect(projects.build(project.id)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' })
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

  it('serializes concurrent installs of the same workflow version', async () => {
    const { directory, database, projects } = openTestServices()
    const root = join(directory, 'project')
    writeProject(root)
    const project = projects.register(root)
    await projects.build(project.id)

    const results = await Promise.allSettled([projects.install(project.id), projects.install(project.id)])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected').map((result) => (result as PromiseRejectedResult).reason))
      .toEqual([expect.objectContaining({ code: 'CONFLICT' })])
    expect(database.installedWorkflows.list()).toHaveLength(1)
  })

  it('removes the finalized directory when installation persistence fails', async () => {
    const directory = temporaryDirectory()
    const database = openAppDatabase(join(directory, 'autoforge.sqlite'))
    const installs = join(directory, 'installed-workflows')
    const projects = new WorkflowProjectService({
      workflowProjects: database.workflowProjects,
      installedWorkflows: {
        ...database.installedWorkflows,
        insert: () => { throw new Error('database unavailable') },
      },
      workflowFiles: database.workflowFiles,
    }, installs)
    const root = join(directory, 'project')
    writeProject(root)
    const project = projects.register(root)
    await projects.build(project.id)

    await expect(projects.install(project.id)).rejects.toThrow('database unavailable')
    expect(existsSync(join(installs, 'browser.search.baidu', '1.0.0'))).toBe(false)
    expect(database.installedWorkflows.get('browser.search.baidu', '1.0.0')).toBeUndefined()
  })

  it('rejects an empty destination created after staging without overwriting it', async () => {
    const directory = temporaryDirectory()
    const database = openAppDatabase(join(directory, 'autoforge.sqlite'))
    const installs = join(directory, 'installed-workflows')
    const destination = join(installs, 'browser.search.baidu', '1.0.0')
    const projects = new WorkflowProjectService(database, installs, {
      beforeReservation: () => { mkdirSync(destination, { recursive: true }) },
    })
    const root = join(directory, 'project')
    writeProject(root)
    const project = projects.register(root)
    await projects.build(project.id)

    await expect(projects.install(project.id)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(existsSync(destination)).toBe(true)
    expect(database.installedWorkflows.get('browser.search.baidu', '1.0.0')).toBeUndefined()
  })

  it('does not remove a destination whose ownership marker changed before persistence fails', async () => {
    const directory = temporaryDirectory()
    const database = openAppDatabase(join(directory, 'autoforge.sqlite'))
    const installs = join(directory, 'installed-workflows')
    const destination = join(installs, 'browser.search.baidu', '1.0.0')
    const projects = new WorkflowProjectService({
      workflowProjects: database.workflowProjects,
      installedWorkflows: {
        ...database.installedWorkflows,
        insert: () => {
          writeFileSync(join(destination, '.autoforge-install-owner'), 'other-owner')
          throw new Error('database unavailable')
        },
      },
      workflowFiles: database.workflowFiles,
    }, installs)
    const root = join(directory, 'project')
    writeProject(root)
    const project = projects.register(root)
    await projects.build(project.id)

    await expect(projects.install(project.id)).rejects.toThrow('database unavailable')
    expect(readFileSync(join(destination, '.autoforge-install-owner'), 'utf8')).toBe('other-owner')
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
