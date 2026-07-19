import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { build } from 'esbuild'
import { strToU8, zipSync } from 'fflate'
import { parseWorkflowManifest, type WorkflowManifest } from '@autoforge/workflow-contracts'
import type { WorkflowProject } from '../../shared/contracts'
import type { AppDatabase, WorkflowProjectRecord } from '../database/app-database'

const sdkDeclaration = `export interface WorkflowResult { ok: boolean; data?: unknown }
export interface WorkflowContext {
  readonly signal: AbortSignal
  navigate(url: string): Promise<void>; waitFor(selector: string, timeout?: number): Promise<void>
  exists(selector: string): Promise<boolean>; readText(selector: string): Promise<string>
  readValue(selector: string): Promise<string>; click(selector: string): Promise<void>
  fill(selector: string, value: string): Promise<void>; selectOption(selector: string, value: string): Promise<void>
  check(selector: string, checked?: boolean): Promise<void>; downloadByClick(selector: string): Promise<string>
  log(level: 'debug'|'info'|'warn'|'error', message: string, data?: unknown): void
}
export type WorkflowRunner = (context: WorkflowContext) => Promise<WorkflowResult>
`

const sourceTemplate = `import type { WorkflowContext, WorkflowResult } from '@autoforge/workflow-sdk'

export async function run(context: WorkflowContext): Promise<WorkflowResult> {
  context.log('info', '工作流开始运行')
  return { ok: true }
}
`

function toProject(row: WorkflowProjectRecord): WorkflowProject { return { ...row, status: row.status as WorkflowProject['status'] } }

export class WorkflowProjectService {
  private readonly watchers = new Map<string, { watcher: FSWatcher; timer?: NodeJS.Timeout }>()
  constructor(private readonly database: AppDatabase) {}

  list(): WorkflowProject[] { return this.database.listWorkflowProjects().map(toProject) }

  async create(parent: string, input: WorkflowManifest): Promise<WorkflowProject> {
    const manifest = parseWorkflowManifest(input); const path = resolve(parent, manifest.slug)
    if (existsSync(path)) throw new Error(`Directory already exists: ${path}`)
    mkdirSync(join(path, 'src'), { recursive: true }); mkdirSync(join(path, 'sdk'), { recursive: true })
    writeFileSync(join(path, 'workflow.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    writeFileSync(join(path, 'README.md'), `# ${manifest.name}\n\n${manifest.description}\n`)
    writeFileSync(join(path, 'tsconfig.json'), `${JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true, noEmit: true, paths: { '@autoforge/workflow-sdk': ['./sdk/index.d.ts'] } }, include: ['src', 'sdk'] }, null, 2)}\n`)
    writeFileSync(join(path, 'sdk/index.d.ts'), sdkDeclaration); writeFileSync(join(path, 'src/index.ts'), sourceTemplate)
    return this.register(path)
  }

  register(path: string): WorkflowProject {
    const absolute = resolve(path); const manifest = parseWorkflowManifest(JSON.parse(readFileSync(join(absolute, 'workflow.json'), 'utf8')))
    if (!existsSync(join(absolute, 'src/index.ts'))) throw new Error('src/index.ts is missing')
    const existing = this.list().find((project) => project.path === absolute)
    const project: WorkflowProject = { id: existing?.id ?? randomUUID(), path: absolute, slug: manifest.slug, name: manifest.name, version: manifest.version, status: 'READY', updatedAt: new Date().toISOString() }
    this.database.upsertWorkflowProject(project); return project
  }

  async build(projectId: string): Promise<WorkflowProject> {
    const project = this.require(projectId); const manifest = parseWorkflowManifest(JSON.parse(readFileSync(join(project.path, 'workflow.json'), 'utf8')))
    this.persist({ ...project, status: 'BUILDING', updatedAt: new Date().toISOString() })
    try {
      const result = await build({ entryPoints: [join(project.path, 'src/index.ts')], bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', legalComments: 'none', external: ['@autoforge/workflow-sdk'] })
      const code = Buffer.from(result.outputFiles[0].contents); const codeSha256 = createHash('sha256').update(code).digest('hex')
      mkdirSync(join(project.path, 'dist'), { recursive: true }); writeFileSync(join(project.path, manifest.entry), code)
      const updated: WorkflowProject = { ...project, name: manifest.name, slug: manifest.slug, version: manifest.version, status: this.watchers.has(projectId) ? 'WATCHING' : 'READY', codeSha256, buildError: undefined, updatedAt: new Date().toISOString() }
      this.persist(updated); return updated
    } catch (error) {
      const updated: WorkflowProject = { ...project, status: 'ERROR', buildError: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() }
      this.persist(updated); throw error
    }
  }

  async watch(projectId: string): Promise<WorkflowProject> {
    if (!this.watchers.has(projectId)) {
      const project = this.require(projectId)
      const state: { watcher: FSWatcher; timer?: NodeJS.Timeout } = { watcher: watch(project.path, { recursive: true }, (_event, file) => {
        if (!file || (!String(file).startsWith('src') && file !== 'workflow.json')) return
        if (state.timer) clearTimeout(state.timer)
        state.timer = setTimeout(() => void this.build(projectId).catch(() => undefined), 150)
      }) }
      this.watchers.set(projectId, state)
    }
    const built = await this.build(projectId); const watching = { ...built, status: 'WATCHING' as const }; this.persist(watching); return watching
  }

  stopWatching(projectId: string): void { const state = this.watchers.get(projectId); if (state?.timer) clearTimeout(state.timer); state?.watcher.close(); this.watchers.delete(projectId) }
  close(): void { for (const id of this.watchers.keys()) this.stopWatching(id) }

  sourceArchive(projectId: string): Buffer {
    const project = this.require(projectId); const files = ['workflow.json', 'README.md', 'tsconfig.json', 'sdk/index.d.ts', 'src/index.ts']
    return Buffer.from(zipSync(Object.fromEntries(files.map((file) => [file, strToU8(readFileSync(join(project.path, file), 'utf8'))])), { level: 9, mtime: new Date('1980-01-01T00:00:00.000Z') }))
  }

  entryPath(projectId: string): string { return join(this.require(projectId).path, 'dist/index.mjs') }
  get(projectId: string): WorkflowProject { return this.require(projectId) }
  private require(id: string) { const project = this.list().find((item) => item.id === id); if (!project) throw new Error('Workflow project not found'); return project }
  private persist(project: WorkflowProject) { this.database.upsertWorkflowProject(project) }
}
