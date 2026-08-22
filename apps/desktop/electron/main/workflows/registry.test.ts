import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowManifest } from '@autoforge/workflow-schema'
import { openAppDatabase } from '../database/client.js'
import type { InstalledWorkflow, WorkflowProject } from '../database/repositories.js'
import { buildFingerprint, WorkflowProjectService } from './project-service.js'
import { WorkflowRegistry } from './registry.js'
import { createWorkflowCatalog } from '../agent/workflow-catalog.js'
import { createWorkflowSourceSelectorVault } from './workflow-source-selector.js'

const temporaryDirectories: string[] = []

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function installedWorkflow(overrides: Partial<InstalledWorkflow> = {}): InstalledWorkflow {
  return {
    workflowId: 'workflow.same',
    version: '1.0.0',
    name: 'Installed workflow',
    description: 'Installed workflow description',
    author: 'AutoForge',
    category: 'automation',
    manifest: {},
    installPath: '',
    enabled: true,
    integrityStatus: 'valid',
    source: 'installed',
    installedAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function readyProject(overrides: Partial<WorkflowProject> = {}): { project: WorkflowProject; manifest: WorkflowManifest; source: string; entry: Buffer } {
  const source = "import { defineWorkflow } from '@autoforge/workflow-sdk'\nexport default defineWorkflow({ run: async () => ({ ok: true }) })\n"
  const entry = Buffer.from('export default {}\n')
  const manifest: WorkflowManifest = {
    id: 'workflow.same',
    version: '1.0.0',
    name: 'Development workflow',
    description: 'Development workflow description',
    author: 'AutoForge',
    category: 'automation',
    entryPath: 'dist/index.js',
    codeSha256: sha256(entry),
    permissions: [],
    activationExamples: ['Run development workflow'],
    activationNegativeExamples: [],
    timeoutMs: 30_000,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    cities: ['北京'],
  }
  return {
    project: {
      id: 'project_same',
      name: 'Development workflow',
      rootPath: '',
      manifest,
      status: 'ready',
      buildHash: buildFingerprint([{ path: 'src/index.ts', contents: Buffer.from(source) }], manifest),
      lastError: undefined,
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    },
    manifest,
    source,
    entry,
  }
}

type InstalledFixture = InstalledWorkflow & { entryContents?: Buffer }

function registryHarness(input: { installed: InstalledFixture[]; projects: ReturnType<typeof readyProject>[] }) {
  const directory = mkdtempSync(join(tmpdir(), 'autoforge-registry-'))
  temporaryDirectories.push(directory)
  const database = openAppDatabase(join(directory, 'autoforge.sqlite'))
  const installations = join(directory, 'installations')
  const projects = new WorkflowProjectService(database, installations)

  for (const candidate of input.projects) {
    const root = join(directory, candidate.project.id)
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'workflow.json'), `${JSON.stringify(candidate.manifest, null, 2)}\n`)
    writeFileSync(join(root, 'src/index.ts'), candidate.source)
    writeFileSync(join(root, 'dist/index.js'), candidate.entry)
    database.workflowProjects.insert({ ...candidate.project, rootPath: root })
  }

  for (const fixture of input.installed) {
    const { entryContents, ...candidate } = fixture
    const root = join(directory, 'installed', candidate.workflowId, candidate.version)
    const manifest = candidate.manifest as Record<string, unknown>
    const entryPath = String(manifest.entryPath)
    const entry = entryContents ?? Buffer.from('export default {}\n')
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'workflow.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    writeFileSync(join(root, entryPath), entry)
    database.installedWorkflows.insert({ ...candidate, installPath: root }, [
      { workflowId: candidate.workflowId, workflowVersion: candidate.version, path: 'workflow.json', sha256: sha256(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)) },
      { workflowId: candidate.workflowId, workflowVersion: candidate.version, path: entryPath, sha256: sha256(entry) },
    ])
  }

  return { registry: new WorkflowRegistry(database, projects), directory, database }
}

function installedRegistryFixture(entryContents: Buffer, extraFileCount = 0) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'autoforge-registry-artifact-'))
  temporaryDirectories.push(temporaryRoot)
  const root = realpathSync(temporaryRoot)
  const manifest = readyProject().manifest
  manifest.codeSha256 = sha256(entryContents)
  const entry = join(root, manifest.entryPath)
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(entry, entryContents)
  const files = [{
    workflowId: manifest.id,
    workflowVersion: manifest.version,
    path: manifest.entryPath,
    sha256: sha256(entryContents),
  }]
  if (extraFileCount > 0) mkdirSync(join(root, 'extra'))
  for (let index = 0; index < extraFileCount; index += 1) {
    const path = `extra/${index}.mjs`
    writeFileSync(join(root, path), '')
    files.push({
      workflowId: manifest.id,
      workflowVersion: manifest.version,
      path,
      sha256: sha256(Buffer.alloc(0)),
    })
  }
  let current = installedWorkflow({ manifest, installPath: root })
  const registry = new WorkflowRegistry({
    installedWorkflows: {
      get: () => current,
      list: () => [current],
      upsert: (value: InstalledWorkflow) => { current = value; return value },
      setEnabled: () => undefined,
    },
    workflowFiles: { list: () => files },
    workflowProjects: { get: () => undefined, list: () => [] },
  } as never, {} as WorkflowProjectService)
  return { registry, entry }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('WorkflowRegistry', () => {
  it('verifies a matching regular installed artifact fixture', async () => {
    const { registry } = installedRegistryFixture(Buffer.from('export default {}\n'))

    await expect(registry.verifyIntegrity('workflow.same', '1.0.0')).resolves.toEqual({ valid: true, disabled: false })
  })

  it('normalizes missing cities and shadows only the exact installed identity with a ready development build', async () => {
    const development = readyProject({ buildHash: 'b'.repeat(64) })
    development.project.buildHash = buildFingerprint([
      { path: 'src/index.ts', contents: Buffer.from(development.source) },
    ], development.manifest)
    const installedManifest = { ...development.manifest }
    delete installedManifest.cities
    const { registry } = registryHarness({
      installed: [
        installedWorkflow({ manifest: installedManifest }),
        installedWorkflow({
          version: '2.0.0',
          manifest: { ...installedManifest, version: '2.0.0' },
        }),
      ],
      projects: [development],
    })

    expect(await registry.list({ developerMode: false })).toMatchObject([
      { id: 'workflow.same', source: 'installed', cities: [] },
      { id: 'workflow.same', version: '2.0.0', source: 'installed', cities: [] },
    ])
    expect(await registry.list({ developerMode: true })).toEqual([
      expect.objectContaining({
        id: 'workflow.same',
        version: '2.0.0',
        source: 'installed',
        cities: [],
      }),
      expect.objectContaining({
        id: 'workflow.same',
        version: '1.0.0',
        source: 'development',
        cities: ['北京'],
        runtimeIdentity: {
          id: 'workflow.same',
          version: '1.0.0',
          source: 'development',
          buildHash: development.project.buildHash,
        },
      }),
    ])
  })

  it.skipIf(process.platform === 'win32')('promptly rejects an installed FIFO without advertising a catalog candidate', async () => {
    const { registry, entry } = installedRegistryFixture(Buffer.from('export default {}\n'))
    unlinkSync(entry)
    execFileSync('mkfifo', [entry])
    const selectorFor = vi.fn(createWorkflowSourceSelectorVault().create)
    const creating = createWorkflowCatalog({ workflows: registry, selectorFor }).create({ developerMode: false })
    const outcome = await Promise.race([
      creating.then((candidates) => ({ type: 'resolved' as const, candidates })),
      new Promise<{ type: 'timed-out' }>((resolvePromise) => {
        setTimeout(() => resolvePromise({ type: 'timed-out' }), 100)
      }),
    ])

    if (outcome.type === 'timed-out') {
      const writer = openSync(entry, constants.O_WRONLY | constants.O_NONBLOCK)
      closeSync(writer)
      await creating
    }
    expect(outcome).toEqual({ type: 'resolved', candidates: [] })
    expect(selectorFor).not.toHaveBeenCalled()
  })

  it('rejects an oversized installed artifact even when its stored digest matches', async () => {
    const entryContents = Buffer.alloc(8 * 1024 * 1024 + 1, 97)
    const { registry } = installedRegistryFixture(entryContents)
    const selectorFor = vi.fn(createWorkflowSourceSelectorVault().create)

    const candidates = await createWorkflowCatalog({ workflows: registry, selectorFor }).create({ developerMode: false })

    expect(candidates).toEqual([])
    expect(selectorFor).not.toHaveBeenCalled()
  })

  it('rejects a symlinked installed artifact even when its target digest matches', async () => {
    const contents = Buffer.from('export default {}\n')
    const { registry, entry } = installedRegistryFixture(contents)
    const target = `${entry}.target`
    writeFileSync(target, contents)
    unlinkSync(entry)
    symlinkSync(target, entry)
    const selectorFor = vi.fn(createWorkflowSourceSelectorVault().create)

    const candidates = await createWorkflowCatalog({ workflows: registry, selectorFor }).create({ developerMode: false })

    expect(candidates).toEqual([])
    expect(selectorFor).not.toHaveBeenCalled()
  })

  it('rejects an installed integrity set above the bounded file count', async () => {
    const { registry } = installedRegistryFixture(Buffer.from('export default {}\n'), 512)
    const selectorFor = vi.fn(createWorkflowSourceSelectorVault().create)

    const candidates = await createWorkflowCatalog({ workflows: registry, selectorFor }).create({ developerMode: false })

    expect(candidates).toEqual([])
    expect(selectorFor).not.toHaveBeenCalled()
  })
})
