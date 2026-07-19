import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { build as esbuild } from 'esbuild'
import { validateManifest, type WorkflowManifest } from '@autoforge/workflow-schema'
import type { AppErrorCode, ValidationResult } from '@autoforge/shared'
import type { AppRepositories, InstalledWorkflow, WorkflowProject } from '../database/repositories.js'

const editableFileLimit = 2 * 1024 * 1024
const textDecoder = new TextDecoder('utf-8', { fatal: true })

type ProjectRepositories = Pick<AppRepositories, 'workflowProjects' | 'installedWorkflows' | 'workflowFiles'>

export interface WorkflowProjectServiceOptions {
  beforeReservation?: () => void | Promise<void>
  removeQuarantine?: (path: string) => Promise<void>
}

const quarantineDirectoryName = '.autoforge-quarantine'
const removalJournalDirectoryName = '.autoforge-removals'
const workflowIdPattern = /^[a-z](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
const workflowVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const operationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

interface RemovalJournal {
  schemaVersion: 1
  operationId: string
  workflowId: string
  workflowVersion: string
  quarantineName: string
  phase: 'prepared' | 'moved'
}

interface InstallationStorage {
  root: string
  quarantineRoot: string
  journalRoot: string
}

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
    private readonly options: WorkflowProjectServiceOptions = {},
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
    return this.withInstallationLock('installation-root', async () => {
      const storage = await this.ensureInstallationStorage()
      await this.recoverRemovalJournalsUnlocked(storage)
      return this.installUnlocked(projectId, storage)
    })
  }

  async removeInstalled(workflowId: string, version: string): Promise<void> {
    return this.withInstallationLock('installation-root', async () => {
      const storage = await this.ensureInstallationStorage()
      await this.recoverRemovalJournalsUnlocked(storage)
      this.validateWorkflowIdentity(workflowId, version)
      const installed = this.repositories.installedWorkflows.get(workflowId, version)
      if (!installed) throw failure('NOT_FOUND')
      const destination = join(storage.root, workflowId, version)
      if (resolve(installed.installPath) !== destination) throw failure('WORKFLOW_INTEGRITY_FAILED')
      const workflowParent = await this.requireSafeWorkflowParent(storage.root, workflowId, false)
      await this.requireSafeDirectory(destination)

      const operationId = randomUUID()
      const quarantine = join(storage.quarantineRoot, operationId)
      const prepared: RemovalJournal = {
        schemaVersion: 1, operationId, workflowId, workflowVersion: version,
        quarantineName: operationId, phase: 'prepared',
      }
      const moved: RemovalJournal = { ...prepared, phase: 'moved' }
      const preparedPath = await this.writeRemovalJournal(storage, prepared)
      await rename(destination, quarantine)
      await Promise.all([this.syncDirectory(workflowParent), this.syncDirectory(storage.quarantineRoot)])
      const movedPath = await this.writeRemovalJournal(storage, moved)
      await this.removeJournal(preparedPath, storage.journalRoot)

      try {
        this.repositories.installedWorkflows.delete(workflowId, version)
      } catch (error) {
        try {
          await rename(quarantine, destination)
          await Promise.all([this.syncDirectory(workflowParent), this.syncDirectory(storage.quarantineRoot)])
          await this.removeJournal(movedPath, storage.journalRoot)
        } catch { /* Preserve the journal for fail-closed recovery. */ }
        throw error
      }
      try {
        await this.removeOwnedQuarantine(quarantine)
        await this.syncDirectory(storage.quarantineRoot)
        await this.removeJournal(movedPath, storage.journalRoot)
      } catch { /* Durable removal already committed; startup retries the exact journal. */ }
    })
  }

  async recoverRemovalJournals(): Promise<void> {
    return this.withInstallationLock('installation-root', async () => {
      const storage = await this.ensureInstallationStorage()
      await this.recoverRemovalJournalsUnlocked(storage)
    })
  }

  private removeOwnedQuarantine(path: string): Promise<void> {
    return this.options.removeQuarantine?.(path)
      ?? rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }

  private async ensureInstallationStorage(): Promise<InstallationStorage> {
    const configuredRoot = resolve(this.installationRoot)
    await mkdir(configuredRoot, { recursive: true })
    const root = await realpath(configuredRoot)
    const quarantineRoot = join(root, quarantineDirectoryName)
    const journalRoot = join(root, removalJournalDirectoryName)
    await mkdir(quarantineRoot)
      .catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
    await mkdir(journalRoot)
      .catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
    await this.requireSafeDirectory(quarantineRoot)
    await this.requireSafeDirectory(journalRoot)
    return { root, quarantineRoot, journalRoot }
  }

  private validateWorkflowIdentity(workflowId: string, version: string): void {
    if (!workflowIdPattern.test(workflowId) || !workflowVersionPattern.test(version)) throw failure('INVALID_INPUT')
  }

  private async requireSafeWorkflowParent(root: string, workflowId: string, create: boolean): Promise<string> {
    if (!workflowIdPattern.test(workflowId)) throw failure('INVALID_INPUT')
    const parent = join(root, workflowId)
    try {
      await this.requireSafeDirectory(parent)
    } catch (error) {
      if (!this.isMissing(error) || !create) throw error
      await mkdir(parent)
      await this.syncDirectory(root)
      await this.requireSafeDirectory(parent)
    }
    return parent
  }

  private async requireSafeDirectory(path: string): Promise<void> {
    const entry = await lstat(path)
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw failure('WORKFLOW_INTEGRITY_FAILED')
  }

  private async writeRemovalJournal(storage: InstallationStorage, journal: RemovalJournal): Promise<string> {
    const finalPath = join(storage.journalRoot, `${journal.operationId}.${journal.phase}.json`)
    const temporaryPath = join(storage.journalRoot, `.${journal.operationId}.${journal.phase}.${randomUUID()}.tmp`)
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(journal)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporaryPath, finalPath)
      await this.syncDirectory(storage.journalRoot)
    } catch (error) {
      await rm(temporaryPath, { force: true })
      throw error
    }
    return finalPath
  }

  private async removeJournal(path: string, journalRoot: string): Promise<void> {
    await rm(path, { force: true })
    await this.syncDirectory(journalRoot)
  }

  private async recoverRemovalJournalsUnlocked(storage: InstallationStorage): Promise<void> {
    const entries = await readdir(storage.journalRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue
      const journalPath = join(storage.journalRoot, entry.name)
      const journal = await this.readRemovalJournal(journalPath, entry.name)
      if (!journal) continue
      await this.recoverRemovalJournal(storage, journalPath, journal)
    }
  }

  private async readRemovalJournal(path: string, name: string): Promise<RemovalJournal | undefined> {
    try {
      const entry = await lstat(path)
      if (entry.isSymbolicLink() || !entry.isFile()) return undefined
      const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      const keys = Object.keys(value).sort().join(',')
      const expectedKeys = 'operationId,phase,quarantineName,schemaVersion,workflowId,workflowVersion'
      if (keys !== expectedKeys
        || value.schemaVersion !== 1
        || typeof value.operationId !== 'string' || !operationIdPattern.test(value.operationId)
        || typeof value.workflowId !== 'string' || !workflowIdPattern.test(value.workflowId)
        || typeof value.workflowVersion !== 'string' || !workflowVersionPattern.test(value.workflowVersion)
        || value.quarantineName !== value.operationId
        || (value.phase !== 'prepared' && value.phase !== 'moved')
        || name !== `${value.operationId}.${value.phase}.json`) return undefined
      return value as unknown as RemovalJournal
    } catch {
      return undefined
    }
  }

  private async recoverRemovalJournal(storage: InstallationStorage, journalPath: string, journal: RemovalJournal): Promise<void> {
    const quarantine = join(storage.quarantineRoot, journal.quarantineName)
    let quarantineExists = false
    try {
      await this.requireSafeDirectory(quarantine)
      quarantineExists = true
    } catch (error) {
      if (!this.isMissing(error)) return
    }

    const installed = this.repositories.installedWorkflows.get(journal.workflowId, journal.workflowVersion)
    if (!quarantineExists) {
      if (!installed) await this.removeJournal(journalPath, storage.journalRoot)
      else {
        const destination = join(storage.root, journal.workflowId, journal.workflowVersion)
        if (resolve(installed.installPath) !== destination) return
        try {
          const parent = await this.requireSafeWorkflowParent(storage.root, journal.workflowId, false)
          await this.requireSafeDirectory(join(parent, journal.workflowVersion))
          await this.removeJournal(journalPath, storage.journalRoot)
        } catch { /* Missing destination or unsafe parent: preserve the journal. */ }
      }
      return
    }

    if (!installed) {
      try {
        await this.removeOwnedQuarantine(quarantine)
        await this.syncDirectory(storage.quarantineRoot)
        await this.removeJournal(journalPath, storage.journalRoot)
      } catch { /* Preserve committed cleanup work for a later retry. */ }
      return
    }

    const destination = join(storage.root, journal.workflowId, journal.workflowVersion)
    if (resolve(installed.installPath) !== destination) return
    try {
      const parent = await this.requireSafeWorkflowParent(storage.root, journal.workflowId, false)
      if (await pathExists(destination)) return
      await rename(quarantine, destination)
      await Promise.all([this.syncDirectory(parent), this.syncDirectory(storage.quarantineRoot)])
      await this.removeJournal(journalPath, storage.journalRoot)
    } catch { /* Conflict or unsafe path: preserve the journal and quarantine. */ }
  }

  private async syncDirectory(path: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(path, 'r')
      await handle.sync()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(code ?? '')) throw error
    } finally {
      await handle?.close()
    }
  }

  private isMissing(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
  }

  private async installUnlocked(projectId: string, storage: InstallationStorage): Promise<InstalledWorkflow> {
    const project = this.require(projectId)
    const validation = await this.validate(project.id)
    if (!validation.valid || project.status !== 'ready') throw failure('INVALID_INPUT')
    const manifest = JSON.parse(await this.readFile(project.id, 'workflow.json')) as WorkflowManifest
    const sourceEntry = await this.filePath(project.id, manifest.entryPath, false)
    const entry = await this.readFile(project.id, manifest.entryPath)
    if (sha256(Buffer.from(entry)) !== manifest.codeSha256) throw failure('WORKFLOW_INTEGRITY_FAILED')
    if (buildFingerprint(await this.readFile(project.id, 'src/index.ts'), manifest) !== project.buildHash) throw failure('INVALID_INPUT')

    this.validateWorkflowIdentity(manifest.id, manifest.version)
    const destination = join(storage.root, manifest.id, manifest.version)
    await this.requireSafeWorkflowParent(storage.root, manifest.id, true)
    if (this.repositories.installedWorkflows.get(manifest.id, manifest.version) || await pathExists(destination)) throw failure('CONFLICT')
    const temporary = join(dirname(destination), `.${basename(destination)}-${randomUUID()}.tmp`)
    const ownershipMarker = join(destination, '.autoforge-install-owner')
    const owner = randomUUID()
    let reserved = false

    try {
      await mkdir(join(temporary, dirname(manifest.entryPath)), { recursive: true })
      await writeFile(join(temporary, 'workflow.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      await copyFile(sourceEntry, join(temporary, manifest.entryPath))
      await this.options.beforeReservation?.()
      await mkdir(destination)
      reserved = true
      await writeFile(ownershipMarker, owner, { flag: 'wx' })
      await rename(join(temporary, 'workflow.json'), join(destination, 'workflow.json'))
      await rename(join(temporary, dirname(manifest.entryPath)), join(destination, dirname(manifest.entryPath)))
      await rm(temporary, { recursive: true, force: true })

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
      if (reserved) await this.removeOwnedDestination(destination, ownershipMarker, owner)
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

  private async removeOwnedDestination(destination: string, ownershipMarker: string, owner: string): Promise<void> {
    try {
      if (await readFile(ownershipMarker, 'utf8') === owner) await rm(destination, { recursive: true, force: true })
    } catch {
      // A missing or replaced marker means this attempt no longer owns the destination.
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
