import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { build as esbuild } from 'esbuild'
import { validateManifest, type WorkflowManifest } from '@autoforge/workflow-schema'
import type { AppErrorCode, ValidationResult } from '@autoforge/shared'
import type { AppRepositories, InstalledWorkflow, WorkflowProject } from '../database/repositories.js'

const editableFileLimit = 2 * 1024 * 1024
const textDecoder = new TextDecoder('utf-8', { fatal: true })

type ProjectRepositories = Pick<AppRepositories, 'workflowProjects' | 'installedWorkflows' | 'workflowFiles'>

function failure(code: AppErrorCode): Error & { code: AppErrorCode } {
  return Object.assign(new Error(code), { code })
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function buildFingerprint(source: string, manifest: WorkflowManifest): string {
  return sha256(Buffer.from(`${source}\u0000${JSON.stringify(manifest)}`))
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

export class WorkflowProjectService {
  private readonly installationLocks = new Map<string, Promise<void>>()

  constructor(
    private readonly repositories: ProjectRepositories,
    private readonly installationRoot: string,
  ) {}

  async create(parentPath: string, manifest: WorkflowManifest): Promise<WorkflowProject> {
    const validation = validateManifest(manifest)
    if (!validation.valid) throw failure('INVALID_INPUT')

    const root = join(resolve(parentPath), manifest.id)
    if (await pathExists(root)) throw failure('CONFLICT')
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'workflow.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await writeFile(join(root, 'src/index.ts'), "import { defineWorkflow } from '@autoforge/workflow-sdk'\n\nexport default defineWorkflow({ run: async () => ({ ok: true }) })\n", 'utf8')
    return this.register(root)
  }

  register(rootPath: string): WorkflowProject {
    const root = resolve(rootPath)
    const canonicalRoot = this.canonicalRootSync(root)
    const manifest = this.readManifestSync(canonicalRoot)
    if (!validateManifest(manifest).valid) throw failure('INVALID_INPUT')

    const sourcePath = this.existingFilePathSync(canonicalRoot, 'src/index.ts')
    try {
      if (!statSync(sourcePath).isFile()) throw failure('NOT_FOUND')
    } catch {
      throw failure('NOT_FOUND')
    }
    const existing = this.repositories.workflowProjects.list().find((project) => project.rootPath === canonicalRoot)
    const now = Date.now()
    const project: WorkflowProject = {
      id: existing?.id ?? randomUUID(),
      name: manifest.name,
      rootPath: canonicalRoot,
      manifest,
      status: existing?.status ?? 'new',
      buildHash: existing?.buildHash,
      lastError: undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    if (existing) return this.repositories.workflowProjects.update(project.id, project) ?? project
    return this.repositories.workflowProjects.insert(project)
  }

  read(projectId: string, path: string): Promise<string> {
    return this.readFile(projectId, path)
  }

  async readFile(projectId: string, path: string): Promise<string> {
    const filePath = await this.filePath(projectId, path, false)
    const file = await stat(filePath)
    if (!file.isFile()) throw failure('INVALID_INPUT')
    if (file.size > editableFileLimit) throw failure('INVALID_INPUT')

    try {
      return textDecoder.decode(await readFile(filePath))
    } catch {
      throw failure('INVALID_INPUT')
    }
  }

  async write(projectId: string, path: string, contents: string): Promise<void> {
    if (Buffer.byteLength(contents, 'utf8') > editableFileLimit) throw failure('INVALID_INPUT')
    const filePath = await this.filePath(projectId, path, true)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, contents, 'utf8')
  }

  async validate(projectId: string): Promise<ValidationResult> {
    const project = this.require(projectId)
    let manifest: unknown
    try {
      manifest = JSON.parse(await this.readFile(project.id, 'workflow.json'))
    } catch {
      const result: ValidationResult = { valid: false, diagnostics: [{ path: '/', message: 'Invalid workflow manifest', severity: 'error' }] }
      this.persist(project.id, { status: 'invalid', lastError: result.diagnostics[0].message })
      return result
    }

    const result = validateManifest(manifest)
    if (!result.valid) this.persist(project.id, { status: 'invalid', lastError: result.diagnostics.map((diagnostic) => diagnostic.message).join('; ') })
    return result
  }

  async build(projectId: string): Promise<WorkflowProject> {
    const project = this.require(projectId)
    const validation = await this.validate(project.id)
    if (!validation.valid) throw failure('INVALID_INPUT')
    const manifest = JSON.parse(await this.readFile(project.id, 'workflow.json')) as WorkflowManifest
    this.persist(project.id, { status: 'building' })

    try {
      const sourcePath = await this.filePath(project.id, 'src/index.ts', false)
      const result = await esbuild({
        entryPoints: [sourcePath],
        bundle: true,
        write: false,
        platform: 'browser',
        format: 'esm',
        target: 'es2022',
        external: ['@autoforge/workflow-sdk'],
        logLevel: 'silent',
      })
      const output = result.outputFiles[0]
      const entryPath = 'dist/index.js'
      const entry = await this.filePath(project.id, entryPath, true)
      await mkdir(dirname(entry), { recursive: true })
      await writeFile(entry, output.contents)

      const builtManifest = { ...manifest, entryPath, codeSha256: sha256(output.contents) }
      const afterBuild = validateManifest(builtManifest)
      if (!afterBuild.valid) throw failure('INVALID_INPUT')
      await this.write(project.id, 'workflow.json', `${JSON.stringify(builtManifest, null, 2)}\n`)

      const buildHash = buildFingerprint(await this.readFile(project.id, 'src/index.ts'), builtManifest)
      return this.persist(project.id, {
        name: builtManifest.name,
        manifest: builtManifest,
        status: 'ready',
        buildHash,
        lastError: undefined,
      }) ?? this.require(project.id)
    } catch (error) {
      this.persist(project.id, {
        status: 'error',
        lastError: error instanceof Error ? error.message : 'Build failed',
      })
      throw error
    }
  }

  async install(projectId: string): Promise<InstalledWorkflow> {
    const project = this.require(projectId)
    const manifest = JSON.parse(await this.readFile(project.id, 'workflow.json')) as WorkflowManifest
    return this.withInstallationLock(`${manifest.id}@${manifest.version}`, () => this.installUnlocked(projectId))
  }

  private async installUnlocked(projectId: string): Promise<InstalledWorkflow> {
    const project = this.require(projectId)
    const validation = await this.validate(project.id)
    if (!validation.valid || project.status !== 'ready') throw failure('INVALID_INPUT')
    const manifest = JSON.parse(await this.readFile(project.id, 'workflow.json')) as WorkflowManifest
    const sourceEntry = await this.filePath(project.id, manifest.entryPath, false)
    const entry = await this.readFile(project.id, manifest.entryPath)
    if (sha256(Buffer.from(entry)) !== manifest.codeSha256) throw failure('WORKFLOW_INTEGRITY_FAILED')
    if (buildFingerprint(await this.readFile(project.id, 'src/index.ts'), manifest) !== project.buildHash) throw failure('INVALID_INPUT')

    const destination = join(resolve(this.installationRoot), manifest.id, manifest.version)
    if (this.repositories.installedWorkflows.get(manifest.id, manifest.version) || await pathExists(destination)) throw failure('CONFLICT')
    await mkdir(dirname(destination), { recursive: true })
    const temporary = join(dirname(destination), `.${basename(destination)}-${randomUUID()}.tmp`)
    let finalized = false

    try {
      await mkdir(join(temporary, dirname(manifest.entryPath)), { recursive: true })
      await writeFile(join(temporary, 'workflow.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      await copyFile(sourceEntry, join(temporary, manifest.entryPath))
      if (await pathExists(destination)) throw failure('CONFLICT')
      await rename(temporary, destination)
      finalized = true

      const now = Date.now()
      const installed: InstalledWorkflow = {
        workflowId: manifest.id,
        version: manifest.version,
        name: manifest.name,
        description: manifest.description,
        author: manifest.author,
        category: manifest.category,
        manifest,
        installPath: destination,
        enabled: true,
        integrityStatus: 'valid',
        source: 'installed',
        installedAt: now,
        updatedAt: now,
      }
      return this.repositories.installedWorkflows.insert(installed, [
        { workflowId: manifest.id, workflowVersion: manifest.version, path: 'workflow.json', sha256: sha256(Buffer.from(JSON.stringify(manifest, null, 2) + '\n')) },
        { workflowId: manifest.id, workflowVersion: manifest.version, path: manifest.entryPath, sha256: manifest.codeSha256 },
      ])
    } catch (error) {
      await rm(temporary, { recursive: true, force: true })
      if (finalized) await rm(destination, { recursive: true, force: true })
      if (error instanceof Error && ('code' in error) && ['EEXIST', 'ENOTEMPTY', 'SQLITE_CONSTRAINT_PRIMARYKEY', 'SQLITE_CONSTRAINT_UNIQUE'].includes(String(error.code))) throw failure('CONFLICT')
      throw error
    }
  }

  private require(projectId: string): WorkflowProject {
    const project = this.repositories.workflowProjects.get(projectId)
    if (!project) throw failure('NOT_FOUND')
    return project
  }

  private persist(projectId: string, value: Partial<WorkflowProject>): WorkflowProject {
    const current = this.require(projectId)
    return this.repositories.workflowProjects.update(projectId, {
      name: value.name ?? current.name,
      manifest: value.manifest ?? current.manifest,
      status: value.status ?? current.status,
      buildHash: value.buildHash ?? current.buildHash,
      lastError: value.lastError ?? current.lastError,
      updatedAt: value.updatedAt ?? Date.now(),
    }) ?? current
  }

  private async filePath(projectId: string, requestedPath: string, forWrite: boolean): Promise<string> {
    if (!requestedPath || isAbsolute(requestedPath)) throw failure('PATH_OUTSIDE_PROJECT')
    const project = this.require(projectId)
    const root = await realpath(project.rootPath)
    const candidate = resolve(root, requestedPath)
    if (!inside(root, candidate)) throw failure('PATH_OUTSIDE_PROJECT')

    let entry: Awaited<ReturnType<typeof lstat>> | undefined
    try {
      entry = await lstat(candidate)
    } catch {
      entry = undefined
    }
    if (entry) {
      if (entry.isSymbolicLink()) throw failure('PATH_OUTSIDE_PROJECT')
      const canonical = await realpath(candidate)
      if (!inside(root, canonical)) throw failure('PATH_OUTSIDE_PROJECT')
      return canonical
    }
    if (!forWrite) throw failure('NOT_FOUND')

    let existingParent = dirname(candidate)
    while (!await pathExists(existingParent)) {
      const parent = dirname(existingParent)
      if (parent === existingParent) throw failure('PATH_OUTSIDE_PROJECT')
      existingParent = parent
    }
    let canonicalParent: string
    try {
      canonicalParent = await realpath(existingParent)
    } catch {
      throw failure('PATH_OUTSIDE_PROJECT')
    }
    if (!inside(root, canonicalParent)) throw failure('PATH_OUTSIDE_PROJECT')
    return candidate
  }

  private readManifestSync(root: string): WorkflowManifest {
    try {
      return JSON.parse(readFileSync(this.existingFilePathSync(root, 'workflow.json'), 'utf8')) as WorkflowManifest
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'PATH_OUTSIDE_PROJECT') throw error
      throw failure('INVALID_INPUT')
    }
  }

  private existingFilePathSync(root: string, requestedPath: string): string {
    const candidate = resolve(root, requestedPath)
    if (!inside(root, candidate)) throw failure('PATH_OUTSIDE_PROJECT')
    try {
      if (lstatSync(candidate).isSymbolicLink()) throw failure('PATH_OUTSIDE_PROJECT')
      const canonical = realpathSync(candidate)
      if (!inside(root, canonical)) throw failure('PATH_OUTSIDE_PROJECT')
      return canonical
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'PATH_OUTSIDE_PROJECT') throw error
      throw failure('NOT_FOUND')
    }
  }

  private async withInstallationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.installationLocks.get(key) ?? Promise.resolve()
    let release: () => void = () => undefined
    const current = new Promise<void>((resolveLock) => { release = resolveLock })
    this.installationLocks.set(key, current)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.installationLocks.get(key) === current) this.installationLocks.delete(key)
    }
  }

  private canonicalRootSync(root: string): string {
    try {
      return realpathSync(root)
    } catch {
      throw failure('NOT_FOUND')
    }
  }
}
