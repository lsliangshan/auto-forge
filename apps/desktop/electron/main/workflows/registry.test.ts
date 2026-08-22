import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkflowManifest } from '@autoforge/workflow-schema'
import { openAppDatabase } from '../database/client.js'
import type { InstalledWorkflow, WorkflowProject } from '../database/repositories.js'
import { buildFingerprint, WorkflowProjectService } from './project-service.js'
import { WorkflowRegistry } from './registry.js'

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
      buildHash: buildFingerprint(source, manifest),
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

function registryHarness(input: { installed: InstalledWorkflow[]; projects: ReturnType<typeof readyProject>[] }) {
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

  for (const candidate of input.installed) {
    const root = join(directory, 'installed', candidate.workflowId, candidate.version)
    const manifest = candidate.manifest as Record<string, unknown>
    const entryPath = String(manifest.entryPath)
    const entry = Buffer.from('export default {}\n')
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'workflow.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    writeFileSync(join(root, entryPath), entry)
    database.installedWorkflows.insert({ ...candidate, installPath: root }, [
      { workflowId: candidate.workflowId, workflowVersion: candidate.version, path: 'workflow.json', sha256: sha256(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)) },
      { workflowId: candidate.workflowId, workflowVersion: candidate.version, path: entryPath, sha256: sha256(entry) },
    ])
  }

  return new WorkflowRegistry(database, projects)
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('WorkflowRegistry', () => {
  it('normalizes missing cities and shadows only the exact installed identity with a ready development build', async () => {
    const development = readyProject({ buildHash: 'b'.repeat(64) })
    development.project.buildHash = buildFingerprint(development.source, development.manifest)
    const installedManifest = { ...development.manifest }
    delete installedManifest.cities
    const registry = registryHarness({
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
})
