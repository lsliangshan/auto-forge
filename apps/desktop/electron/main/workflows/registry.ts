import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { validateManifest, type WorkflowManifest } from '@autoforge/workflow-schema'
import type { WorkflowDetail } from '@autoforge/shared'
import type { AppRepositories, InstalledWorkflow } from '../database/repositories.js'
import { buildFingerprint, WorkflowProjectService } from './project-service.js'

type RegistryRepositories = Pick<AppRepositories, 'workflowProjects' | 'installedWorkflows' | 'workflowFiles'>

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function timestamp(value: number): string {
  return new Date(value).toISOString()
}

function identityKey(workflow: Pick<WorkflowDetail, 'id' | 'version'>): string {
  return `${workflow.id}\u0000${workflow.version}`
}

function toDetail(workflow: InstalledWorkflow): WorkflowDetail | undefined {
  const result = validateManifest(workflow.manifest)
  if (!result.valid) return undefined
  const manifest = workflow.manifest as WorkflowManifest
  return {
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    description: manifest.description,
    author: manifest.author,
    category: manifest.category,
    enabled: workflow.enabled,
    source: 'installed',
    integrity: workflow.integrityStatus === 'failed' ? 'failed' : workflow.integrityStatus === 'valid' ? 'valid' : 'unchecked',
    updatedAt: timestamp(workflow.updatedAt),
    codeSha256: manifest.codeSha256,
    cities: manifest.cities ?? [],
    runtimeIdentity: { id: manifest.id, version: manifest.version, source: 'installed' },
    permissions: manifest.permissions,
    activationExamples: manifest.activationExamples,
    activationNegativeExamples: manifest.activationNegativeExamples,
    timeoutMs: manifest.timeoutMs,
    inputSchema: manifest.inputSchema,
    outputSchema: manifest.outputSchema,
  }
}

export class WorkflowRegistry {
  constructor(
    private readonly repositories: RegistryRepositories,
    private readonly projects: WorkflowProjectService,
  ) {}

  async list(options: { developerMode?: boolean } = {}): Promise<WorkflowDetail[]> {
    await Promise.all(this.repositories.installedWorkflows.list().map((workflow) => this.verifyIntegrity(workflow.workflowId, workflow.version)))
    const installed = this.repositories.installedWorkflows.list().map(toDetail).filter((workflow): workflow is WorkflowDetail => workflow !== undefined)
    if (!options.developerMode) return installed

    const development = await Promise.all(
      this.repositories.workflowProjects.list().map((project) => this.getDevelopmentProject(project.id)),
    )
    const developmentDetails = development.filter((workflow): workflow is WorkflowDetail => workflow !== undefined)
    const developmentByIdentity = new Map(developmentDetails.map((workflow) => [identityKey(workflow), workflow]))
    return [
      ...installed.filter((workflow) => !developmentByIdentity.has(identityKey(workflow))),
      ...developmentDetails,
    ]
  }

  async getDevelopmentProject(projectId: string): Promise<WorkflowDetail | undefined> {
    const project = this.repositories.workflowProjects.get(projectId)
    if (!project || project.status !== 'ready' || !project.buildHash) return undefined
    try {
      const manifest = JSON.parse(await this.projects.read(project.id, 'workflow.json')) as WorkflowManifest
      if (!validateManifest(manifest).valid) return undefined
      const source = await this.projects.read(project.id, 'src/index.ts')
      const entry = await this.projects.read(project.id, manifest.entryPath)
      if (buildFingerprint(source, manifest) !== project.buildHash || sha256(Buffer.from(entry)) !== manifest.codeSha256) return undefined
      return {
        id: manifest.id,
        version: manifest.version,
        name: manifest.name,
        description: manifest.description,
        author: manifest.author,
        category: manifest.category,
        enabled: true,
        source: 'development',
        integrity: 'valid',
        updatedAt: timestamp(project.updatedAt),
        codeSha256: manifest.codeSha256,
        cities: manifest.cities ?? [],
        runtimeIdentity: {
          id: manifest.id,
          version: manifest.version,
          source: 'development',
          buildHash: project.buildHash,
        },
        permissions: manifest.permissions,
        activationExamples: manifest.activationExamples,
        activationNegativeExamples: manifest.activationNegativeExamples,
        timeoutMs: manifest.timeoutMs,
        inputSchema: manifest.inputSchema,
        outputSchema: manifest.outputSchema,
      }
    } catch {
      return undefined
    }
  }

  async get(workflowId: string, version: string, options: { developerMode?: boolean } = {}): Promise<WorkflowDetail | undefined> {
    return (await this.list(options)).find((workflow) => workflow.id === workflowId && workflow.version === version)
  }

  setEnabled(workflowId: string, version: string, enabled: boolean): void {
    this.repositories.installedWorkflows.setEnabled(workflowId, version, enabled)
  }

  async verifyIntegrity(workflowId: string, version: string): Promise<{ valid: boolean; disabled: boolean }> {
    const installed = this.repositories.installedWorkflows.get(workflowId, version)
    if (!installed) return { valid: false, disabled: false }

    const root = resolve(installed.installPath)
    const files = this.repositories.workflowFiles.list(workflowId, version)
    const valid = files.length > 0 && await Promise.all(files.map(async (file) => {
      const path = resolve(root, file.path)
      if (path !== root && !path.startsWith(`${root}${sep}`)) return false
      try {
        const canonical = await realpath(path)
        if (canonical !== root && !canonical.startsWith(`${root}${sep}`)) return false
        return sha256(await readFile(canonical)) === file.sha256
      } catch {
        return false
      }
    })).then((results) => results.every(Boolean))

    if (!valid) {
      this.repositories.installedWorkflows.upsert({ ...installed, enabled: false, integrityStatus: 'failed', updatedAt: Date.now() })
      return { valid: false, disabled: true }
    }
    this.repositories.installedWorkflows.upsert({ ...installed, integrityStatus: 'valid', updatedAt: Date.now() })
    return { valid: true, disabled: false }
  }
}
