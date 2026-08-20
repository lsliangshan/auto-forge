import Ajv, { type AnySchema } from 'ajv'
import { acceptHMRUpdate, defineStore } from 'pinia'
import type {
  ApprovalDecision,
  DeveloperProject,
  ExecutionDetail,
  ExecutionEvent,
  ValidationDiagnostic,
  ValidationResult,
} from '@autoforge/shared'
import type { WorkflowManifest } from '@autoforge/workflow-schema'
import { displayError, getDesktopApi } from '../services/desktop-api'

export type FileSaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

interface FileBuffer {
  projectId: string
  path: string
  content: string
  version: number
  loading: boolean
  loaded: boolean
  error: string
  saveState: FileSaveState
}

interface DeveloperRuntime {
  timers: Map<string, ReturnType<typeof setTimeout>>
  queues: Map<string, Promise<void>>
  unsubscribe?: () => void
  pendingEvents: ExecutionEvent[]
}

const runtimes = new WeakMap<object, DeveloperRuntime>()
const wrapped = new WeakSet<object>()

function runtime(store: object): DeveloperRuntime {
  const existing = runtimes.get(store)
  if (existing) return existing
  const created: DeveloperRuntime = { timers: new Map(), queues: new Map(), pendingEvents: [] }
  runtimes.set(store, created)
  return created
}

function bufferKey(projectId: string, path: string): string {
  return `${projectId}\u0000${path}`
}

function entryContains(entryPath: string, candidatePath: string): boolean {
  return candidatePath === entryPath || candidatePath.startsWith(`${entryPath}/`)
}

function renamedPath(path: string, name: string): string {
  const separator = path.lastIndexOf('/')
  return separator === -1 ? name : `${path.slice(0, separator + 1)}${name}`
}

function moveEntryPath(candidatePath: string, sourcePath: string, destinationPath: string): string {
  return candidatePath === sourcePath ? destinationPath : `${destinationPath}${candidatePath.slice(sourcePath.length)}`
}

function parseManifest(value: string): WorkflowManifest | undefined {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' ? parsed as WorkflowManifest : undefined
  } catch {
    return undefined
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'interrupted'])

export const useDeveloperStore = defineStore('developer', {
  state: () => ({
    projects: [] as DeveloperProject[],
    selectedProjectId: '',
    selectedPath: '',
    openPaths: {} as Record<string, string[]>,
    files: {} as Record<string, FileBuffer>,
    manifests: {} as Record<string, WorkflowManifest | undefined>,
    diagnostics: [] as ValidationDiagnostic[],
    validationValid: true,
    loading: false,
    error: '',
    _projectVersions: {} as Record<string, number>,
    _selectionGeneration: 0,
    _runToken: 0,
    debugInput: {} as unknown,
    debugDraftValid: true,
    debugDraftError: '',
    debugEvents: [] as ExecutionEvent[],
    debugDetail: undefined as ExecutionDetail | undefined,
    debugExecutionId: '',
    debugStatus: 'idle' as 'idle' | 'starting' | 'queued' | 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted',
    debugError: '',
  }),
  getters: {
    selectedProject(state): DeveloperProject | undefined {
      return state.projects.find(({ id }) => id === state.selectedProjectId)
    },
    currentBuffer(state): FileBuffer | undefined {
      return state.files[bufferKey(state.selectedProjectId, state.selectedPath)]
    },
    currentContent(): string { return this.currentBuffer?.content ?? '' },
    currentOpenPaths(state): string[] { return state.openPaths[state.selectedProjectId] ?? [] },
    currentManifest(state): WorkflowManifest | undefined { return state.manifests[state.selectedProjectId] },
    saveState(): FileSaveState { return this.currentBuffer?.saveState ?? 'idle' },
    fileUnavailableReason(): string { return this.currentBuffer?.error ?? '' },
    pendingApproval(): Extract<ExecutionEvent, { type: 'approval_required' }> | undefined {
      for (let index = this.debugEvents.length - 1; index >= 0; index -= 1) {
        const event = this.debugEvents[index]!
        if (event.type === 'approval_required') return event
        if (event.type === 'status' && event.status !== 'awaiting_approval') return undefined
      }
      return undefined
    },
  },
  actions: {
    _ensureLifecycle() {
      const state = runtime(this)
      if (!state.unsubscribe) {
        state.unsubscribe = getDesktopApi().executions.onEvent((event) => this._receiveExecutionEvent(event))
      }
      if (wrapped.has(this)) return
      wrapped.add(this)
      const dispose = this.$dispose.bind(this)
      this.$dispose = () => {
        void this.flushPendingSaves()
        for (const timer of state.timers.values()) clearTimeout(timer)
        state.timers.clear()
        state.unsubscribe?.()
        runtimes.delete(this)
        dispose()
      }
    },
    async loadProjects() {
      this._ensureLifecycle()
      this.loading = true
      this.error = ''
      try {
        this.projects = await getDesktopApi().developer.listProjects()
        if (!this.projects.some(({ id }) => id === this.selectedProjectId)) {
          const first = this.projects[0]
          this.selectedProjectId = first?.id ?? ''
          this.selectedPath = ''
          if (first) await this.selectProject(first.id)
        }
      } catch (error) {
        this.error = displayError(error, '项目列表加载失败')
      } finally {
        this.loading = false
      }
    },
    async createProject(name: string) {
      try {
        const project = await getDesktopApi().developer.createProject(name)
        this._upsertProject(project)
        await this.selectProject(project.id)
      } catch (error) { this.error = displayError(error, '创建项目失败') }
    },
    async registerProject() {
      try {
        const project = await getDesktopApi().developer.registerProject()
        if (!project) return
        this._upsertProject(project)
        await this.selectProject(project.id)
      } catch (error) { this.error = displayError(error, '导入项目失败') }
    },
    _upsertProject(project: DeveloperProject) {
      const index = this.projects.findIndex(({ id }) => id === project.id)
      if (index === -1) this.projects.push(project)
      else this.projects[index] = project
    },
    async selectProject(projectId: string) {
      const project = this.projects.find(({ id }) => id === projectId)
      if (!project) return
      this._selectionGeneration += 1
      this._runToken += 1
      this.selectedProjectId = projectId
      this.diagnostics = []
      this.validationValid = true
      this.debugInput = {}
      this.debugDraftValid = true
      this.debugDraftError = ''
      this.resetDebug()
      const preferred = project.files.includes('src/index.ts') ? 'src/index.ts' : project.files[0]
      this.selectedPath = ''
      if (preferred) await this.selectFile(preferred)
      if (project.files.includes('workflow.json')) await this._loadFile(projectId, 'workflow.json')
    },
    async selectFile(path: string) {
      const project = this.selectedProject
      if (!project || !project.files.includes(path)) return
      const openPaths = this.openPaths[project.id] ?? []
      if (!openPaths.includes(path)) this.openPaths[project.id] = [...openPaths, path]
      this.selectedPath = path
      await this._loadFile(project.id, path)
    },
    async closeFile(path: string) {
      const projectId = this.selectedProjectId
      const openPaths = this.openPaths[projectId] ?? []
      const index = openPaths.indexOf(path)
      if (index === -1) return
      await this.flushPendingSaves()
      const remaining = openPaths.filter((openPath) => openPath !== path)
      this.openPaths[projectId] = remaining
      if (this.selectedPath !== path) return
      this.selectedPath = ''
      const next = remaining[index] ?? remaining[index - 1]
      if (next) await this.selectFile(next)
    },
    async createEntry(parentPath: string, name: string, kind: 'file' | 'directory') {
      const projectId = this.selectedProjectId
      if (!projectId) return
      this.error = ''
      try {
        const project = await getDesktopApi().developer.createEntry(projectId, parentPath, name, kind)
        this._upsertProject(project)
        if (kind === 'file') {
          const path = parentPath ? `${parentPath}/${name}` : name
          await this.selectFile(path)
        }
      } catch (error) { this.error = displayError(error, '创建文件或目录失败') }
    },
    async renameEntry(path: string, name: string) {
      const projectId = this.selectedProjectId
      if (!projectId) return
      this.error = ''
      await this._flushEntry(projectId, path)
      if (Object.values(this.files).some((buffer) => buffer.projectId === projectId
        && entryContains(path, buffer.path) && buffer.saveState === 'error')) {
        this.error = '存在未保存文件，请修复保存问题后重试。'
        return
      }
      try {
        const project = await getDesktopApi().developer.renameEntry(projectId, path, name)
        const destination = renamedPath(path, name)
        this._upsertProject(project)
        for (const [key, buffer] of Object.entries(this.files)) {
          if (buffer.projectId !== projectId || !entryContains(path, buffer.path)) continue
          delete this.files[key]
          buffer.path = moveEntryPath(buffer.path, path, destination)
          this.files[bufferKey(projectId, buffer.path)] = buffer
        }
        this.openPaths[projectId] = (this.openPaths[projectId] ?? [])
          .map((openPath) => entryContains(path, openPath) ? moveEntryPath(openPath, path, destination) : openPath)
        if (entryContains(path, this.selectedPath)) this.selectedPath = moveEntryPath(this.selectedPath, path, destination)
      } catch (error) { this.error = displayError(error, '重命名失败') }
    },
    async deleteEntry(path: string) {
      const projectId = this.selectedProjectId
      if (!projectId) return
      this.error = ''
      await this._flushEntry(projectId, path)
      if (Object.values(this.files).some((buffer) => buffer.projectId === projectId
        && entryContains(path, buffer.path) && buffer.saveState === 'error')) {
        this.error = '存在未保存文件，请修复保存问题后重试。'
        return
      }
      try {
        const project = await getDesktopApi().developer.deleteEntry(projectId, path)
        const previousOpenPaths = this.openPaths[projectId] ?? []
        const selectedIndex = previousOpenPaths.indexOf(this.selectedPath)
        this._upsertProject(project)
        for (const [key, buffer] of Object.entries(this.files)) {
          if (buffer.projectId === projectId && entryContains(path, buffer.path)) delete this.files[key]
        }
        const remaining = previousOpenPaths.filter((openPath) => !entryContains(path, openPath) && project.files.includes(openPath))
        this.openPaths[projectId] = remaining
        if (!entryContains(path, this.selectedPath)) return
        this.selectedPath = ''
        const next = remaining[selectedIndex] ?? remaining[selectedIndex - 1]
          ?? (project.files.includes('src/index.ts') ? 'src/index.ts' : project.files[0])
        if (next) await this.selectFile(next)
      } catch (error) { this.error = displayError(error, '删除失败') }
    },
    async _loadFile(projectId: string, path: string) {
      const key = bufferKey(projectId, path)
      const existing = this.files[key]
      if (existing?.loaded || existing?.loading) return
      const buffer: FileBuffer = existing ?? {
        projectId, path, content: '', version: 0, loading: false, loaded: false, error: '', saveState: 'idle',
      }
      buffer.loading = true
      buffer.error = ''
      this.files[key] = buffer
      try {
        buffer.content = await getDesktopApi().developer.readFile(projectId, path)
        buffer.loaded = true
        if (path === 'workflow.json') this.manifests[projectId] = parseManifest(buffer.content)
      } catch (error) {
        buffer.error = typeof error === 'object' && error !== null && 'code' in error && error.code === 'INVALID_INPUT'
          ? '文件过大、包含二进制内容或不可编辑'
          : displayError(error, '文件加载失败')
      } finally { buffer.loading = false }
    },
    editCurrent(content: string) {
      const buffer = this.currentBuffer
      if (!buffer?.loaded || buffer.error) return
      buffer.content = content
      buffer.version += 1
      buffer.saveState = 'dirty'
      this._projectVersions[buffer.projectId] = (this._projectVersions[buffer.projectId] ?? 0) + 1
      if (buffer.path === 'workflow.json') this.manifests[buffer.projectId] = parseManifest(content)
      const key = bufferKey(buffer.projectId, buffer.path)
      const state = runtime(this)
      const previous = state.timers.get(key)
      if (previous) clearTimeout(previous)
      state.timers.set(key, setTimeout(() => {
        state.timers.delete(key)
        void this._enqueueSave(key)
      }, 400))
    },
    _enqueueSave(key: string): Promise<void> {
      const state = runtime(this)
      const previous = state.queues.get(key) ?? Promise.resolve()
      const buffer = this.files[key]
      if (!buffer?.loaded || buffer.saveState === 'idle' || buffer.saveState === 'saved') return previous
      const snapshot = { content: buffer.content, version: buffer.version, projectVersion: this._projectVersions[buffer.projectId] ?? 0 }
      const queued = previous.catch(() => undefined).then(() => this._persistSnapshot(key, snapshot))
      state.queues.set(key, queued)
      void queued.finally(() => { if (state.queues.get(key) === queued) state.queues.delete(key) })
      return queued
    },
    async _flushEntry(projectId: string, path: string) {
      const state = runtime(this)
      const pending: Promise<void>[] = []
      for (const [key, timer] of [...state.timers]) {
        const buffer = this.files[key]
        if (!buffer || buffer.projectId !== projectId || !entryContains(path, buffer.path)) continue
        clearTimeout(timer)
        state.timers.delete(key)
        pending.push(this._enqueueSave(key))
      }
      for (const [key, queue] of state.queues) {
        const buffer = this.files[key]
        if (buffer?.projectId === projectId && entryContains(path, buffer.path)) pending.push(queue)
      }
      await Promise.allSettled(pending)
    },
    saveCurrent(): Promise<void> {
      if (!this.selectedProjectId || !this.selectedPath) return Promise.resolve()
      const key = bufferKey(this.selectedProjectId, this.selectedPath)
      const state = runtime(this)
      const timer = state.timers.get(key)
      if (timer) {
        clearTimeout(timer)
        state.timers.delete(key)
      }
      return this._enqueueSave(key)
    },
    async _persistSnapshot(key: string, snapshot: { content: string; version: number; projectVersion: number }) {
      const buffer = this.files[key]
      if (!buffer) return
      if (buffer.version === snapshot.version) buffer.saveState = 'saving'
      try {
        await getDesktopApi().developer.writeFile(buffer.projectId, buffer.path, snapshot.content)
        const validation = await getDesktopApi().developer.validate(buffer.projectId)
        if ((this._projectVersions[buffer.projectId] ?? 0) === snapshot.projectVersion
          && buffer.version === snapshot.version
          && this.selectedProjectId === buffer.projectId) {
          this._applyValidation(validation)
          buffer.saveState = 'saved'
        } else if (buffer.version !== snapshot.version) buffer.saveState = 'dirty'
      } catch (error) {
        if (buffer.version === snapshot.version) {
          buffer.saveState = 'error'
          this.error = displayError(error, '文件保存失败')
        }
      }
    },
    _applyValidation(result: ValidationResult) {
      this.validationValid = result.valid
      this.diagnostics = result.diagnostics
    },
    async flushPendingSaves() {
      const state = runtime(this)
      const pending: Promise<void>[] = []
      for (const [key, timer] of state.timers) {
        clearTimeout(timer)
        state.timers.delete(key)
        pending.push(this._enqueueSave(key))
      }
      pending.push(...state.queues.values())
      await Promise.allSettled(pending)
    },
    async validateProject() {
      const projectId = this.selectedProjectId
      if (!projectId) return false
      await this.flushPendingSaves()
      const projectVersion = this._projectVersions[projectId] ?? 0
      try {
        const result = await getDesktopApi().developer.validate(projectId)
        if (this.selectedProjectId === projectId && (this._projectVersions[projectId] ?? 0) === projectVersion) this._applyValidation(result)
        return result.valid
      } catch (error) {
        this.error = displayError(error, '项目校验失败')
        return false
      }
    },
    async buildProject() {
      const projectId = this.selectedProjectId
      if (!projectId) return
      await this.flushPendingSaves()
      if (Object.values(this.files).some((file) => file.projectId === projectId && ['dirty', 'saving', 'error'].includes(file.saveState))) {
        this.error = '存在未保存文件，请修复保存问题后重试。'
        return
      }
      try {
        this._upsertProject(await getDesktopApi().developer.build(projectId))
        await this._refreshBuiltManifest(projectId)
        await this.validateProject()
      } catch (error) { this.error = displayError(error, '项目构建失败') }
    },
    async _refreshBuiltManifest(projectId: string, shouldApply: () => boolean = () => true) {
      const key = bufferKey(projectId, 'workflow.json')
      const buffer = this.files[key]
      if (!buffer) return false
      const content = await getDesktopApi().developer.readFile(projectId, 'workflow.json')
      if (!shouldApply()) return false
      buffer.content = content
      buffer.version += 1
      buffer.loaded = true
      buffer.error = ''
      buffer.saveState = 'saved'
      this._projectVersions[projectId] = (this._projectVersions[projectId] ?? 0) + 1
      this.manifests[projectId] = parseManifest(content)
      return true
    },
    setDebugDraftValidity(valid: boolean, error = '') {
      this.debugDraftValid = valid
      this.debugDraftError = valid ? '' : error
    },
    ensureExecutionSubscription() { this._ensureLifecycle() },
    async runDebug() {
      const projectId = this.selectedProjectId
      if (!projectId || !this.currentManifest || ['starting', 'queued', 'awaiting_approval', 'running'].includes(this.debugStatus)) return
      this._ensureLifecycle()
      this.debugError = ''
      if (!this.debugDraftValid) {
        this.debugError = this.debugDraftError || '调试输入 JSON 无效。'
        return
      }
      let manifest: WorkflowManifest
      let input: unknown
      try {
        manifest = cloneJson(this.currentManifest)
        input = cloneJson(this.debugInput)
      } catch {
        this.debugError = '调试输入必须是有效 JSON。'
        return
      }
      try {
        const validate = new Ajv({ allErrors: true, strict: false }).compile(manifest.inputSchema as AnySchema)
        if (!validate(input)) {
          this.debugError = `调试输入无效：${validate.errors?.map(({ instancePath, message }) => `${instancePath || '/'} ${message ?? ''}`).join('；')}`
          return
        }
      } catch {
        this.debugError = '输入 Schema 无效，请先修复 workflow.json。'
        return
      }
      this.resetDebug()
      const selectionGeneration = this._selectionGeneration
      const runToken = ++this._runToken
      const isCurrent = () => this.selectedProjectId === projectId
        && this._selectionGeneration === selectionGeneration
        && this._runToken === runToken
      this.debugStatus = 'starting'
      const state = runtime(this)
      state.pendingEvents = []
      try {
        await this.flushPendingSaves()
        if (!isCurrent()) return
        if (Object.values(this.files).some((file) => file.projectId === projectId && ['dirty', 'saving', 'error'].includes(file.saveState))) {
          this.debugStatus = 'failed'
          this.debugError = '存在未保存文件，请修复保存问题后重试。'
          return
        }
        const built = await getDesktopApi().developer.build(projectId)
        if (!isCurrent()) return
        this._upsertProject(built)
        if (!await this._refreshBuiltManifest(projectId, isCurrent) || !isCurrent()) return
        const validation = await getDesktopApi().developer.validate(projectId)
        if (!isCurrent()) return
        this._applyValidation(validation)
        if (!validation.valid) { this.debugStatus = 'idle'; this.debugError = '项目校验未通过。'; return }
        const { executionId } = await getDesktopApi().developer.run({ projectId, input })
        if (!isCurrent()) {
          try { await getDesktopApi().executions.cancel(executionId) } catch { /* A stale execution may already be terminal. */ }
          return
        }
        this.debugExecutionId = executionId
        this.debugStatus = 'queued'
        for (const event of state.pendingEvents) if (event.executionId === executionId) this._applyExecutionEvent(event)
      } catch (error) {
        if (!isCurrent()) return
        this.debugStatus = 'failed'
        this.debugError = displayError(error, '调试运行失败')
      } finally { if (isCurrent()) state.pendingEvents = [] }
    },
    resetDebug() {
      this.debugEvents = []
      this.debugDetail = undefined
      this.debugExecutionId = ''
      this.debugStatus = 'idle'
      this.debugError = ''
      const state = runtime(this)
      state.pendingEvents = []
    },
    _receiveExecutionEvent(event: ExecutionEvent) {
      if (this.debugExecutionId && event.executionId === this.debugExecutionId) this._applyExecutionEvent(event)
      else if (this.debugStatus === 'starting') runtime(this).pendingEvents.push(event)
    },
    _applyExecutionEvent(event: ExecutionEvent) {
      this.debugEvents.push(event)
      if (event.type === 'status') {
        this.debugStatus = event.status
        if (event.error) this.debugError = event.error.message
        if (terminalStatuses.has(event.status)) void this._loadDebugDetail(event.executionId)
      }
    },
    async _loadDebugDetail(executionId: string) {
      try {
        const detail = await getDesktopApi().executions.get(executionId)
        if (this.debugExecutionId === executionId) this.debugDetail = detail
      } catch (error) {
        if (this.debugExecutionId === executionId) this.debugError = displayError(error, '调试结果加载失败')
      }
    },
    async decideApproval(decision: 'once' | 'always' | 'deny') {
      const approval = this.pendingApproval
      const manifest = this.currentManifest
      if (!approval || !manifest || approval.executionId !== this.debugExecutionId) return
      const input: ApprovalDecision = decision === 'always' ? {
        executionId: approval.executionId,
        permissionIndex: approval.permissionIndex,
        scopeHash: approval.scopeHash,
        decision,
        workflowId: manifest.id,
        workflowVersion: manifest.version,
        capability: approval.capability,
        scope: approval.scope,
      } : {
        executionId: approval.executionId,
        permissionIndex: approval.permissionIndex,
        scopeHash: approval.scopeHash,
        decision,
      }
      try { await getDesktopApi().executions.decide(input) }
      catch (error) { this.debugError = displayError(error, '授权处理失败') }
    },
    async cancelDebug() {
      if (!this.debugExecutionId || terminalStatuses.has(this.debugStatus)) return
      try { await getDesktopApi().executions.cancel(this.debugExecutionId) }
      catch (error) { this.debugError = displayError(error, '取消执行失败') }
    },
  },
})

if (import.meta.hot) import.meta.hot.accept(acceptHMRUpdate(useDeveloperStore, import.meta.hot))
