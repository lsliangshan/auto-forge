import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus, { ElMessageBox } from 'element-plus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopAPI, DeveloperProject, ExecutionEvent, ValidationResult } from '@autoforge/shared'
import CodeEditor from '../../src/components/developer/CodeEditor.vue'
import DebugPanel from '../../src/components/developer/DebugPanel.vue'
import FileTree from '../../src/components/developer/FileTree.vue'
import { useDeveloperStore } from '../../src/stores/developer'

const monacoHarness = vi.hoisted(() => {
  interface Model {
    uri: { toString(): string }
    value: string
    language: string
    disposed: boolean
    getValue(): string
    setValue(value: string): void
    getLineMaxColumn(line: number): number
    dispose(): void
  }
  const models = new Map<string, Model>()
  let activeModel: Model | null = null
  let changeListener = () => undefined
  let saveCommand = () => undefined
  const disposeEditor = vi.fn()
  const setModelMarkers = vi.fn()
  const setTheme = vi.fn()
  const find = vi.fn()
  const replace = vi.fn()
  const trigger = vi.fn((_source: string, id: string) => {
    if (id === 'actions.find') find()
    if (id === 'editor.action.startFindReplaceAction') replace()
  })
  const createModel = (value: string, language: string, uri: { toString(): string }): Model => {
    const model: Model = {
      uri, value, language, disposed: false,
      getValue: () => model.value,
      setValue: (next) => { model.value = next },
      getLineMaxColumn: () => model.value.split('\n')[0]!.length + 1,
      dispose: () => { model.disposed = true; models.delete(uri.toString()) },
    }
    models.set(uri.toString(), model)
    return model
  }
  return {
    models, disposeEditor, setModelMarkers, setTheme, trigger,
    reset() {
      models.clear(); activeModel = null; changeListener = () => undefined; saveCommand = () => undefined
      disposeEditor.mockClear(); setModelMarkers.mockClear(); setTheme.mockClear(); find.mockClear(); replace.mockClear(); trigger.mockClear()
    },
    change(value: string) { if (!activeModel) throw new Error('No active Monaco model'); activeModel.value = value; changeListener() },
    save() { saveCommand() },
    find,
    replace,
    api: {
      KeyMod: { CtrlCmd: 2048 },
      KeyCode: { KeyS: 49 },
      Uri: { parse: (value: string) => ({ toString: () => value }) },
      editor: {
        create: vi.fn(() => ({
          getModel: () => activeModel,
          setModel: (model: Model) => { activeModel = model },
          onDidChangeModelContent: (listener: () => void) => { changeListener = listener; return { dispose: vi.fn() } },
          addCommand: (_keybinding: number, handler: () => void) => { saveCommand = handler },
          getAction: () => null,
          focus: vi.fn(),
          trigger,
          updateOptions: vi.fn(), layout: vi.fn(), dispose: disposeEditor,
        })),
        createModel,
        getModel: (uri: { toString(): string }) => models.get(uri.toString()),
        setModelLanguage: (model: Model, language: string) => { model.language = language },
        setModelMarkers,
        setTheme,
      },
    },
  }
})

const workerHarness = vi.hoisted(() => {
  const instances: Array<{ kind: string; terminate: ReturnType<typeof vi.fn> }> = []
  const constructorFor = (kind: string) => class {
    kind = kind
    terminate = vi.fn()
    constructor() { instances.push(this) }
  }
  return { instances, constructorFor }
})

vi.mock('monaco-editor/esm/vs/editor/editor.api.js', () => monacoHarness.api)
vi.mock('monaco-editor/esm/vs/language/json/monaco.contribution.js', () => ({}))
vi.mock('monaco-editor/esm/vs/language/css/monaco.contribution.js', () => ({}))
vi.mock('monaco-editor/esm/vs/language/typescript/monaco.contribution.js', () => ({}))
vi.mock('monaco-editor/esm/vs/editor/editor.worker?worker', () => ({ default: workerHarness.constructorFor('editor') }))
vi.mock('monaco-editor/esm/vs/language/json/json.worker?worker', () => ({ default: workerHarness.constructorFor('json') }))
vi.mock('monaco-editor/esm/vs/language/css/css.worker?worker', () => ({ default: workerHarness.constructorFor('css') }))
vi.mock('monaco-editor/esm/vs/language/typescript/ts.worker?worker', () => ({ default: workerHarness.constructorFor('typescript') }))

const project: DeveloperProject = {
  id: 'project_1', name: 'Baidu search', rootPath: '/private/project', status: 'new',
  chatAvailability: 'ready',
  files: ['src/index.ts', 'workflow.json'], directories: ['src'], updatedAt: '2026-07-19T00:00:00.000Z',
}

function createApi() {
  let executionListener: ((event: ExecutionEvent) => void) | undefined
  const api = {
    auth: {
      getSession: vi.fn().mockResolvedValue(null), sendOtp: vi.fn(), verifyOtp: vi.fn(),
      cancelOtp: vi.fn().mockResolvedValue(undefined), loginWithPassword: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
    },
    profile: {
      get: vi.fn().mockResolvedValue({ userId: 'user_1', account: 'Alice' }),
      update: vi.fn(),
      pickAndUploadAvatar: vi.fn().mockResolvedValue(null),
    },
    chat: {}, workflows: {}, permissions: {}, settings: {}, system: {},
    developer: {
      listProjects: vi.fn().mockResolvedValue([project]), createProject: vi.fn(), registerProject: vi.fn(),
      readFile: vi.fn(async (_projectId: string, path: string) => path === 'workflow.json'
        ? JSON.stringify({
            id: 'browser.search.baidu', version: '1.0.0', name: 'Baidu', description: '', author: 'AutoForge', category: 'browser',
            entryPath: 'dist/index.js', codeSha256: 'a'.repeat(64), timeoutMs: 30_000,
            activationExamples: ['搜索天气'], activationNegativeExamples: ['写一封邮件'],
            permissions: [{ capability: 'browser.open', scope: { origins: ['https://www.baidu.com'] } }],
            inputSchema: {
              type: 'object', required: ['keyword'], properties: {
                keyword: { type: 'string', title: '关键词' }, count: { type: 'integer' }, exact: { type: 'boolean' },
                region: { type: 'string', enum: ['北京', '上海'] }, filters: { type: 'object' },
              },
            }, outputSchema: { type: 'object' },
          })
        : 'export default 1'),
      writeFile: vi.fn().mockResolvedValue(undefined),
      createEntry: vi.fn().mockResolvedValue(project), renameEntry: vi.fn().mockResolvedValue(project), deleteEntry: vi.fn().mockResolvedValue(project),
      build: vi.fn().mockResolvedValue({ ...project, status: 'ready' }),
      validate: vi.fn().mockResolvedValue({ valid: true, diagnostics: [] } satisfies ValidationResult),
      run: vi.fn().mockResolvedValue({ executionId: 'exec_1' }),
    },
    executions: {
      onEvent: vi.fn((listener: (event: ExecutionEvent) => void) => { executionListener = listener; return vi.fn() }),
      decide: vi.fn(), cancel: vi.fn(), get: vi.fn().mockResolvedValue({
        id: 'exec_1', workflowId: 'browser.search.baidu', workflowVersion: '1.0.0', status: 'completed',
        createdAt: '2026-07-19T00:00:00.000Z', input: {}, output: { success: true }, steps: [], logs: [],
      }),
    },
  }
  return { api: api as unknown as DesktopAPI, raw: api, emit: (event: ExecutionEvent) => executionListener?.(event) }
}

describe('developer workbench', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    monacoHarness.reset()
    setActivePinia(createPinia())
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    Reflect.deleteProperty(window, 'autoForge')
  })

  it('saves the active project file after 400 ms and refreshes authoritative validation', async () => {
    const { api, raw } = createApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    await store.selectFile('src/index.ts')
    const wrapper = mount(CodeEditor, { global: { plugins: [ElementPlus] } })
    await wrapper.vm.$nextTick()
    await Promise.resolve()

    monacoHarness.change('export default 2')
    expect(store.saveState).toBe('dirty')
    await vi.advanceTimersByTimeAsync(399)
    expect(raw.developer.writeFile).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(raw.developer.writeFile).toHaveBeenCalledWith('project_1', 'src/index.ts', 'export default 2'))
    expect(raw.developer.validate).toHaveBeenCalledWith('project_1')
    expect(store.saveState).toBe('saved')
    expect(wrapper.attributes()).not.toHaveProperty('data-local-path')
  })

  it.each([
    ['unbuilt_changes', '有未构建修改，暂不可用于聊天'],
    ['not_built', '尚未构建，暂不可用于聊天'],
    ['invalid', '项目无效，暂不可用于聊天'],
    ['ready', ''],
  ] as const)('renders authoritative %s chat availability without building on mount', async (chatAvailability, message) => {
    const { api, raw } = createApi()
    raw.developer.listProjects.mockResolvedValue([{ ...project, chatAvailability }])
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    const wrapper = mount(CodeEditor)
    await wrapper.vm.$nextTick()

    expect(store.chatAvailabilityMessage).toBe(message)
    if (message) expect(wrapper.get('[data-testid="chat-availability"]').text()).toBe(message)
    else expect(wrapper.find('[data-testid="chat-availability"]').exists()).toBe(false)
    expect(raw.developer.build).not.toHaveBeenCalled()
  })

  it('creates Monaco after the initial file read finishes', async () => {
    const { api, raw } = createApi()
    let resolveSource!: (content: string) => void
    raw.developer.readFile.mockImplementation((_projectId: string, path: string) => path === 'src/index.ts'
      ? new Promise<string>((resolve) => { resolveSource = resolve })
      : Promise.resolve('{}'))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    const wrapper = mount(CodeEditor)

    const loading = store.loadProjects()
    await vi.waitFor(() => expect(store.currentBuffer?.loading).toBe(true))
    expect(monacoHarness.api.editor.create).not.toHaveBeenCalled()
    resolveSource('export default 1')
    await loading
    await wrapper.vm.$nextTick()

    expect(monacoHarness.api.editor.create).toHaveBeenCalledOnce()
  })

  it('creates Monaco with the active color scheme and follows later scheme changes', async () => {
    let change!: (event: { matches: boolean }) => void
    const removeEventListener = vi.fn()
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      addEventListener: (_event: string, listener: typeof change) => { change = listener },
      removeEventListener,
    })))
    const { api } = createApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    await store.selectFile('src/index.ts')

    const wrapper = mount(CodeEditor)
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    expect(monacoHarness.api.editor.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ theme: 'vs-dark' }))

    change({ matches: false })
    expect(monacoHarness.setTheme).toHaveBeenLastCalledWith('vs')
    wrapper.unmount()
    expect(removeEventListener).toHaveBeenCalledOnce()
  })

  it('keeps independent Monaco models when switching files and disposes them on unmount', async () => {
    const { api } = createApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    await store.selectFile('src/index.ts')
    const wrapper = mount(CodeEditor)
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    monacoHarness.change('dirty source')
    await store.selectFile('workflow.json')
    await wrapper.vm.$nextTick()
    monacoHarness.change('{"dirty":true}')
    await store.selectFile('src/index.ts')
    await wrapper.vm.$nextTick()

    expect(store.currentContent).toBe('dirty source')
    expect([...monacoHarness.models.keys()]).toEqual(expect.arrayContaining([
      'autoforge://project/project_1/src/index.ts', 'autoforge://project/project_1/workflow.json',
    ]))
    wrapper.unmount()
    expect(monacoHarness.disposeEditor).toHaveBeenCalledOnce()
    expect([...monacoHarness.models.values()].every((model) => model.disposed)).toBe(true)
  })

  it('opens selected files in tabs and selects a neighbor when the active tab closes', async () => {
    const { api } = createApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    await store.selectFile('workflow.json')
    const wrapper = mount(CodeEditor)
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[data-testid="editor-tab-src/index.ts"]').text()).toContain('index.ts')
    expect(wrapper.get('[data-testid="editor-tab-workflow.json"]').classes()).toContain('active')
    await wrapper.get('[data-testid="close-tab-workflow.json"]').trigger('click')
    await vi.waitFor(() => {
      expect(store.selectedPath).toBe('src/index.ts')
      expect(wrapper.find('[data-testid="editor-tab-workflow.json"]').exists()).toBe(false)
    })
  })

  it('saves immediately from the Monaco shortcut and exposes find and replace actions', async () => {
    const { api, raw } = createApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    const wrapper = mount(CodeEditor)
    await wrapper.vm.$nextTick()
    await Promise.resolve()

    monacoHarness.change('export default 3')
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="editor-tab-src/index.ts"]').classes()).toContain('dirty')
    monacoHarness.save()
    await Promise.resolve()
    await Promise.resolve()
    expect(raw.developer.writeFile).toHaveBeenCalledWith('project_1', 'src/index.ts', 'export default 3')
    await vi.advanceTimersByTimeAsync(399)
    expect(raw.developer.writeFile).toHaveBeenCalledOnce()

    await wrapper.get('[data-testid="editor-find"]').trigger('click')
    await wrapper.get('[data-testid="editor-replace"]').trigger('click')
    expect(monacoHarness.find).toHaveBeenCalledOnce()
    expect(monacoHarness.replace).toHaveBeenCalledOnce()
    expect(monacoHarness.trigger).toHaveBeenNthCalledWith(1, 'autoforge-toolbar', 'actions.find', null)
    expect(monacoHarness.trigger).toHaveBeenNthCalledWith(2, 'autoforge-toolbar', 'editor.action.startFindReplaceAction', null)
  })

  it('creates a file and opens the refreshed entry from the developer store', async () => {
    const { api, raw } = createApi()
    const withDocs = { ...project, directories: ['docs', 'src'] }
    const withDraft = { ...withDocs, files: ['docs/draft.md', ...project.files] }
    raw.developer.listProjects.mockResolvedValue([withDocs])
    raw.developer.createEntry.mockResolvedValue(withDraft)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()

    await store.createEntry('docs', 'draft.md', 'file')

    expect(raw.developer.createEntry).toHaveBeenCalledWith('project_1', 'docs', 'draft.md', 'file')
    expect(store.selectedPath).toBe('docs/draft.md')
    expect(store.currentOpenPaths).toContain('docs/draft.md')
  })

  it('moves open buffers on rename and removes them after deletion', async () => {
    const { api, raw } = createApi()
    const withNotes = {
      ...project, directories: ['docs', 'src'], files: ['docs/notes.md', ...project.files],
    }
    const renamed = { ...withNotes, files: ['docs/readme.md', ...project.files] }
    const deleted = { ...withNotes, files: [...project.files] }
    raw.developer.listProjects.mockResolvedValue([withNotes])
    raw.developer.renameEntry.mockResolvedValue(renamed)
    raw.developer.deleteEntry.mockResolvedValue(deleted)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    await store.selectFile('docs/notes.md')
    store.editCurrent('edited notes')

    await store.renameEntry('docs/notes.md', 'readme.md')

    expect(raw.developer.writeFile).toHaveBeenCalledWith('project_1', 'docs/notes.md', 'edited notes')
    expect(raw.developer.renameEntry).toHaveBeenCalledWith('project_1', 'docs/notes.md', 'readme.md')
    expect(store.selectedPath).toBe('docs/readme.md')
    expect(store.currentContent).toBe('edited notes')
    expect(store.currentOpenPaths).toContain('docs/readme.md')

    await store.deleteEntry('docs/readme.md')

    expect(raw.developer.deleteEntry).toHaveBeenCalledWith('project_1', 'docs/readme.md')
    expect(store.currentOpenPaths).not.toContain('docs/readme.md')
    expect(store.selectedPath).toBe('src/index.ts')
  })

  it('does not select a created file in a different project after an async response', async () => {
    const { api, raw } = createApi()
    const second = {
      ...project, id: 'project_2', name: 'Second', rootPath: '/private/second',
      directories: ['docs', 'src'], files: ['docs/draft.md', ...project.files],
    }
    raw.developer.listProjects.mockResolvedValue([project, second])
    let resolveCreate!: (value: DeveloperProject) => void
    raw.developer.createEntry.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()

    const operation = store.createEntry('docs', 'draft.md', 'file')
    await vi.waitFor(() => expect(raw.developer.createEntry).toHaveBeenCalled())
    await store.selectProject('project_2')
    resolveCreate({ ...project, directories: ['docs', 'src'], files: ['docs/draft.md', ...project.files] })
    await operation

    expect(store.selectedProjectId).toBe('project_2')
    expect(store.selectedPath).toBe('src/index.ts')
  })

  it('does not move the active path in a different project after rename or delete resolves', async () => {
    const { api, raw } = createApi()
    const first = { ...project, directories: ['docs', 'src'], files: ['docs/notes.md', ...project.files] }
    const second = { ...first, id: 'project_2', name: 'Second', rootPath: '/private/second' }
    raw.developer.listProjects.mockResolvedValue([first, second])
    let resolveRename!: (value: DeveloperProject) => void
    raw.developer.renameEntry.mockReturnValue(new Promise((resolve) => { resolveRename = resolve }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    await store.selectFile('docs/notes.md')

    const renameOperation = store.renameEntry('docs/notes.md', 'readme.md')
    await vi.waitFor(() => expect(raw.developer.renameEntry).toHaveBeenCalled())
    await store.selectProject('project_2')
    await store.selectFile('docs/notes.md')
    resolveRename({ ...first, files: ['docs/readme.md', ...project.files] })
    await renameOperation

    expect(store.selectedProjectId).toBe('project_2')
    expect(store.selectedPath).toBe('docs/notes.md')

    let resolveDelete!: (value: DeveloperProject) => void
    raw.developer.deleteEntry.mockReturnValue(new Promise((resolve) => { resolveDelete = resolve }))
    await store.selectProject('project_1')
    const deleteOperation = store.deleteEntry('docs/readme.md')
    await vi.waitFor(() => expect(raw.developer.deleteEntry).toHaveBeenCalled())
    await store.selectProject('project_2')
    await store.selectFile('docs/notes.md')
    resolveDelete({ ...first, files: [...project.files] })
    await deleteOperation

    expect(store.selectedProjectId).toBe('project_2')
    expect(store.selectedPath).toBe('docs/notes.md')
  })

  it('renders project paths as a collapsible directory tree', async () => {
    const { api, raw } = createApi()
    raw.developer.listProjects.mockResolvedValue([{
      ...project, directories: ['docs', 'src'], files: ['docs/notes.md', ...project.files],
    }])
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    const wrapper = mount(FileTree, { global: { plugins: [ElementPlus] } })

    expect(wrapper.get('[data-testid="tree-entry-src"]').text()).toContain('src')
    expect(wrapper.get('[data-testid="tree-entry-src/index.ts"]').text()).toContain('index.ts')
    await wrapper.get('[data-testid="tree-entry-src"]').trigger('click')
    expect(wrapper.find('[data-testid="tree-entry-src/index.ts"]').exists()).toBe(false)
    store._upsertProject({ ...store.selectedProject!, directories: ['docs', 'src', 'vendor'] })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="tree-entry-src/index.ts"]').exists()).toBe(false)
    await wrapper.get('[data-testid="tree-entry-src"]').trigger('click')
    expect(wrapper.find('[data-testid="tree-entry-src/index.ts"]').exists()).toBe(true)
  })

  it('offers create, rename and confirmed delete actions from the file tree context menu', async () => {
    const { api, raw } = createApi()
    const initial = { ...project, directories: ['docs', 'src'], files: ['docs/notes.md', ...project.files] }
    const withDraft = { ...initial, files: ['docs/draft.md', 'docs/notes.md', ...project.files] }
    const renamed = { ...initial, files: ['docs/draft.md', 'docs/readme.md', ...project.files] }
    const deleted = { ...initial, files: ['docs/draft.md', ...project.files] }
    raw.developer.listProjects.mockResolvedValue([initial])
    raw.developer.createEntry.mockResolvedValue(withDraft)
    raw.developer.renameEntry.mockResolvedValue(renamed)
    raw.developer.deleteEntry.mockResolvedValue(deleted)
    vi.spyOn(ElMessageBox, 'prompt')
      .mockResolvedValueOnce({ value: 'draft.md', action: 'confirm' })
      .mockResolvedValueOnce({ value: 'readme.md', action: 'confirm' })
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm')
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    const wrapper = mount(FileTree, { attachTo: document.body, global: { plugins: [ElementPlus] } })

    await wrapper.get('[data-testid="tree-entry-docs"]').trigger('contextmenu')
    expect(wrapper.find('[data-action="create-file"]').exists()).toBe(true)
    await wrapper.get('[data-action="create-file"]').trigger('click')
    await vi.waitFor(() => expect(raw.developer.createEntry).toHaveBeenCalledWith('project_1', 'docs', 'draft.md', 'file'))

    await wrapper.get('[data-testid="tree-entry-docs/notes.md"]').trigger('contextmenu')
    await wrapper.get('[data-action="rename"]').trigger('click')
    await vi.waitFor(() => expect(raw.developer.renameEntry).toHaveBeenCalledWith('project_1', 'docs/notes.md', 'readme.md'))

    await wrapper.get('[data-testid="tree-entry-docs/readme.md"]').trigger('contextmenu')
    await wrapper.get('[data-action="delete"]').trigger('click')
    await vi.waitFor(() => expect(raw.developer.deleteEntry).toHaveBeenCalledWith('project_1', 'docs/readme.md'))
    expect(ElMessageBox.confirm).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('targets the project whose root context menu was opened', async () => {
    const { api, raw } = createApi()
    const second = { ...project, id: 'project_2', name: 'Second', rootPath: '/private/second' }
    raw.developer.listProjects.mockResolvedValue([project, second])
    raw.developer.createEntry.mockResolvedValue({ ...second, directories: ['docs', 'src'] })
    vi.spyOn(ElMessageBox, 'prompt').mockResolvedValue({ value: 'docs', action: 'confirm' })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    const wrapper = mount(FileTree, { attachTo: document.body, global: { plugins: [ElementPlus] } })

    await wrapper.findAll('.project-row')[1]!.trigger('contextmenu')
    await wrapper.get('[data-action="create-directory"]').trigger('click')

    await vi.waitFor(() => expect(raw.developer.createEntry).toHaveBeenCalledWith('project_2', '', 'docs', 'directory'))
    wrapper.unmount()
  })

  it('keeps renderer-scoped language workers alive across editor remounts', async () => {
    const { api } = createApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    await store.selectFile('src/index.ts')
    const environment = globalThis.MonacoEnvironment as { getWorker(moduleId: string, label: string): Worker }
    const first = environment.getWorker('', 'typescript') as unknown as { terminate: ReturnType<typeof vi.fn> }

    const firstEditor = mount(CodeEditor)
    await firstEditor.vm.$nextTick()
    firstEditor.unmount()
    expect(first.terminate).not.toHaveBeenCalled()

    const secondEditor = mount(CodeEditor)
    await secondEditor.vm.$nextTick()
    expect(environment.getWorker('', 'typescript')).toBe(first)
    expect(workerHarness.instances.filter(({ kind }) => kind === 'typescript')).toHaveLength(1)
    secondEditor.unmount()
  })

  it('does not let an older save or validation overwrite newer edits', async () => {
    const { api, raw } = createApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    let resolveWrite!: () => void
    let resolveValidation!: (value: ValidationResult) => void
    raw.developer.writeFile.mockReturnValueOnce(new Promise<void>((resolve) => { resolveWrite = resolve }))
    raw.developer.validate.mockReturnValueOnce(new Promise((resolve) => { resolveValidation = resolve }))
    const store = useDeveloperStore()
    await store.loadProjects()
    await store.selectFile('src/index.ts')
    const wrapper = mount(CodeEditor)
    await wrapper.vm.$nextTick()
    await Promise.resolve()

    monacoHarness.change('version one')
    await vi.advanceTimersByTimeAsync(400)
    monacoHarness.change('version two')
    resolveWrite()
    await Promise.resolve()
    resolveValidation({ valid: false, diagnostics: [{ path: '/', message: 'stale', severity: 'error' }] })
    await Promise.resolve()
    expect(store.saveState).toBe('dirty')
    expect(store.diagnostics).toEqual([])
    await vi.advanceTimersByTimeAsync(400)
    await vi.waitFor(() => expect(raw.developer.writeFile).toHaveBeenLastCalledWith('project_1', 'src/index.ts', 'version two'))
    wrapper.unmount()
  })

  it('renders schema-driven primitive fields and an explicit JSON editor for complex values', async () => {
    const { api } = createApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    await store.selectFile('workflow.json')
    const wrapper = mount(DebugPanel, { global: { plugins: [ElementPlus] } })

    expect(wrapper.get('[data-testid="debug-field-keyword"]').attributes('required')).toBeDefined()
    expect(wrapper.get('[data-testid="debug-field-count"]').attributes('type')).toBe('number')
    expect(wrapper.get('[data-testid="debug-field-exact"]').attributes('type')).toBe('checkbox')
    expect(wrapper.get('[data-testid="debug-field-region"]').element.tagName).toBe('SELECT')
    expect(wrapper.get('[data-testid="debug-field-filters-json"]').text()).toContain('JSON')
    expect(wrapper.text()).toContain('browser.open')
    expect(wrapper.text()).not.toContain('filesystem.read')
  })

  it('keeps invalid complex JSON as a visible draft and blocks execution', async () => {
    const { api, raw } = createApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    await store.selectFile('workflow.json')
    const wrapper = mount(DebugPanel, { global: { plugins: [ElementPlus] } })

    await wrapper.get('[data-testid="debug-field-filters-json"] textarea').setValue('{ invalid')
    expect(wrapper.text()).toContain('请输入有效 JSON')
    expect(store.debugDraftValid).toBe(false)
    await store.runDebug()
    expect(raw.developer.build).not.toHaveBeenCalled()
    expect(raw.developer.run).not.toHaveBeenCalled()
  })

  it('blocks invalid root JSON without replacing the last valid input', async () => {
    const { api, raw } = createApi()
    const manifest = JSON.parse(await raw.developer.readFile('project_1', 'workflow.json')) as Record<string, unknown>
    manifest.inputSchema = { type: 'object' }
    raw.developer.readFile.mockImplementation(async (_projectId: string, path: string) => path === 'workflow.json'
      ? JSON.stringify(manifest) : 'export default 1')
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    await store.selectFile('workflow.json')
    const wrapper = mount(DebugPanel, { global: { plugins: [ElementPlus] } })
    const rootInput = wrapper.get('[data-testid="debug-root-json"]')

    await rootInput.setValue('{')
    expect(store.debugInput).toEqual({})
    await store.runDebug()
    expect(raw.developer.build).not.toHaveBeenCalled()
    await rootInput.setValue('{"query":"ok"}')
    expect(store.debugDraftValid).toBe(true)
    await store.runDebug()
    expect(raw.developer.run).toHaveBeenCalledWith({ projectId: 'project_1', input: { query: 'ok' } })
  })

  it('runs a new project without dynamic code generation in the renderer', async () => {
    const { api, raw } = createApi()
    const manifest = JSON.parse(await raw.developer.readFile('project_1', 'workflow.json')) as Record<string, unknown>
    manifest.inputSchema = { type: 'object', additionalProperties: true }
    raw.developer.readFile.mockImplementation(async (_projectId: string, path: string) => path === 'workflow.json'
      ? JSON.stringify(manifest) : 'export default 1')
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    await store.selectFile('workflow.json')
    const nativeFunction = globalThis.Function
    Object.defineProperty(globalThis, 'Function', {
      configurable: true,
      writable: true,
      value: function blockedDynamicFunction() { throw new EvalError('Refused by Content Security Policy') },
    })

    try {
      await store.runDebug()
    } finally {
      Object.defineProperty(globalThis, 'Function', { configurable: true, writable: true, value: nativeFunction })
    }

    expect(store.debugError).toBe('')
    expect(raw.developer.run).toHaveBeenCalledWith({ projectId: 'project_1', input: {} })
  })

  it('shows a semantic workflow input validation error without queueing an execution', async () => {
    const { api, raw } = createApi()
    raw.developer.run.mockResolvedValueOnce({ validationError: '搜索关键词不能为空' } as never)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    await store.selectFile('workflow.json')

    await store.runDebug()

    expect(store.debugStatus).toBe('failed')
    expect(store.debugError).toBe('搜索关键词不能为空')
    expect(store.debugExecutionId).toBe('')
  })

  it('initializes required booleans and preserves enum values with distinct JSON types', async () => {
    const { api, raw } = createApi()
    const manifest = JSON.parse(await raw.developer.readFile('project_1', 'workflow.json')) as Record<string, unknown>
    manifest.inputSchema = {
      type: 'object', required: ['exact'],
      properties: { exact: { type: 'boolean' }, choice: { enum: [1, '1'] } },
    }
    raw.developer.readFile.mockImplementation(async (_projectId: string, path: string) => path === 'workflow.json'
      ? JSON.stringify(manifest) : 'export default 1')
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    await store.selectFile('workflow.json')
    const wrapper = mount(DebugPanel, { global: { plugins: [ElementPlus] } })

    expect(store.debugInput).toMatchObject({ exact: false })
    const select = wrapper.get('[data-testid="debug-field-choice"]')
    expect(select.text()).toContain('1 (number)')
    expect(select.text()).toContain('"1" (string)')
    await select.setValue('0')
    expect((store.debugInput as Record<string, unknown>).choice).toBe(1)
    await select.setValue('1')
    expect((store.debugInput as Record<string, unknown>).choice).toBe('1')
  })

  it('submits an unchanged schema-driven input on consecutive debug runs', async () => {
    const { api, raw, emit } = createApi()
    raw.developer.run
      .mockResolvedValueOnce({ executionId: 'exec_1' })
      .mockResolvedValueOnce({ executionId: 'exec_2' })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    await store.selectFile('workflow.json')
    const wrapper = mount(DebugPanel, { global: { plugins: [ElementPlus] } })

    await wrapper.get('[data-testid="debug-field-keyword"]').setValue('今日天气')
    await wrapper.get('.debug-actions .el-button--primary').trigger('click')
    await vi.waitFor(() => expect(raw.developer.run).toHaveBeenCalledTimes(1))
    emit({
      type: 'status', executionId: 'exec_1', status: 'completed',
      occurredAt: '2026-08-20T00:00:00.000Z',
    })
    await wrapper.vm.$nextTick()

    await wrapper.get('.debug-actions .el-button--primary').trigger('click')
    await vi.waitFor(() => expect(raw.developer.run).toHaveBeenCalledTimes(2))

    expect(raw.developer.run).toHaveBeenNthCalledWith(1, { projectId: 'project_1', input: { keyword: '今日天气' } })
    expect(raw.developer.run).toHaveBeenNthCalledWith(2, { projectId: 'project_1', input: { keyword: '今日天气' } })
  })

  it('renders a live execution log only once after terminal details load', async () => {
    const { api, raw, emit } = createApi()
    raw.executions.get.mockResolvedValue({
      id: 'exec_1', workflowId: 'browser.search.baidu', workflowVersion: '1.0.0', status: 'completed',
      createdAt: '2026-08-21T00:00:00.000Z', input: {}, output: { success: true }, steps: [],
      logs: [{
        id: 'log_1', executionId: 'exec_1', sequence: 0, level: 'info',
        message: '正在使用百度搜索：今日天气', createdAt: '2026-08-21T00:00:01.000Z',
      }],
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    await store.selectFile('workflow.json')
    store.debugInput = { keyword: '今日天气' }
    await store.runDebug()
    const wrapper = mount(DebugPanel, { global: { plugins: [ElementPlus] } })

    emit({
      type: 'log', executionId: 'exec_1', level: 'info', message: '正在使用百度搜索：今日天气',
      occurredAt: '2026-08-21T00:00:01.000Z',
    })
    emit({
      type: 'status', executionId: 'exec_1', status: 'completed',
      occurredAt: '2026-08-21T00:00:02.000Z',
    })

    await vi.waitFor(() => expect(store.debugDetail?.logs).toHaveLength(1))
    await wrapper.vm.$nextTick()
    expect(wrapper.text().split('正在使用百度搜索：今日天气')).toHaveLength(2)
  })

  it('isolates execution events, handles approvals, and cancels only the active debug run', async () => {
    const { api, raw, emit } = createApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    await store.selectFile('workflow.json')
    store.debugInput = { keyword: '今日天气' }
    await store.runDebug()
    emit({ type: 'log', executionId: 'other', level: 'info', message: 'ignore', occurredAt: '2026-07-19T00:00:00.000Z' })
    emit({
      type: 'approval_required', executionId: 'exec_1', permissionIndex: 0, capability: 'browser.open',
      scope: { origins: ['https://www.baidu.com'] }, scopeHash: 'b'.repeat(64), occurredAt: '2026-07-19T00:00:01.000Z',
    })
    await store.decideApproval('once')
    emit({ type: 'log', executionId: 'exec_1', level: 'info', message: 'started', occurredAt: '2026-07-19T00:00:02.000Z' })
    await store.cancelDebug()

    expect(store.debugEvents.some((event) => event.executionId === 'other')).toBe(false)
    expect(raw.executions.decide).toHaveBeenCalledWith({
      executionId: 'exec_1', permissionIndex: 0, scopeHash: 'b'.repeat(64), decision: 'once',
    })
    expect(raw.executions.cancel).toHaveBeenCalledWith('exec_1')
    expect(raw.executions.onEvent).toHaveBeenCalledTimes(1)
  })

  it('sends a structured-cloneable persistent approval decision', async () => {
    const { api, raw, emit } = createApi()
    let transferredDecision: unknown
    raw.executions.decide.mockImplementation(async (input: unknown) => {
      transferredDecision = structuredClone(input)
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    await store.selectFile('workflow.json')
    store.debugInput = { keyword: '今日天气' }
    await store.runDebug()
    emit({
      type: 'approval_required', executionId: 'exec_1', permissionIndex: 0, capability: 'browser.open',
      scope: { origins: ['https://www.baidu.com'] }, scopeHash: 'b'.repeat(64), occurredAt: '2026-07-19T00:00:01.000Z',
    })

    await store.decideApproval('always')

    expect(store.debugError).toBe('')
    expect(transferredDecision).toEqual({
      executionId: 'exec_1', permissionIndex: 0, scopeHash: 'b'.repeat(64), decision: 'always',
      workflowId: 'browser.search.baidu', workflowVersion: '1.0.0', capability: 'browser.open',
      scope: { origins: ['https://www.baidu.com'] },
    })
  })

  it('shows a safe non-editable state when Main rejects a large or binary file', async () => {
    const { api, raw } = createApi()
    raw.developer.readFile.mockRejectedValue(Object.assign(new Error('redacted'), { code: 'INVALID_INPUT' }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    await store.selectFile('src/index.ts')
    const wrapper = mount(CodeEditor)
    expect(wrapper.text()).toContain('文件过大、包含二进制内容或不可编辑')
    expect(monacoHarness.api.editor.create).not.toHaveBeenCalled()
  })

  it('keeps an editable dirty buffer when a save fails', async () => {
    const { api, raw } = createApi()
    raw.developer.writeFile.mockRejectedValueOnce(Object.assign(new Error('redacted'), { code: 'INTERNAL_ERROR' }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    await store.selectFile('src/index.ts')
    const wrapper = mount(CodeEditor)
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    monacoHarness.change('still editable')
    await vi.advanceTimersByTimeAsync(400)
    await Promise.resolve()

    expect(store.saveState).toBe('error')
    expect(store.currentContent).toBe('still editable')
    expect(wrapper.text()).not.toContain('无法编辑此文件')
    expect(monacoHarness.models.size).toBeGreaterThan(0)
  })

  it('reloads the build-generated manifest integrity without saving stale JSON back over it', async () => {
    const { api, raw } = createApi()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    const builtManifest = { ...store.currentManifest, codeSha256: 'c'.repeat(64) }
    raw.developer.readFile.mockResolvedValueOnce(JSON.stringify(builtManifest))

    await store.buildProject()

    expect(store.currentManifest?.codeSha256).toBe('c'.repeat(64))
    expect(raw.developer.writeFile).not.toHaveBeenCalledWith('project_1', 'workflow.json', expect.stringContaining('"codeSha256":"aaaaaaaa'))
  })

  it('does not apply an old project build after selection changes', async () => {
    const { api, raw } = createApi()
    const second = { ...project, id: 'project_2', name: 'Second project', rootPath: '/private/second' }
    raw.developer.listProjects.mockResolvedValue([project, second])
    let resolveBuild!: (value: DeveloperProject) => void
    raw.developer.build.mockReturnValueOnce(new Promise((resolve) => { resolveBuild = resolve }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    store.debugInput = { keyword: 'captured' }
    const run = store.runDebug()
    await Promise.resolve()
    await store.selectProject(second.id)
    resolveBuild({ ...project, status: 'ready', name: 'stale build' })
    await run

    expect(store.selectedProjectId).toBe(second.id)
    expect(store.projects.find(({ id }) => id === project.id)?.name).toBe(project.name)
    expect(raw.developer.validate).not.toHaveBeenCalled()
    expect(raw.developer.run).not.toHaveBeenCalled()
    expect(store.debugStatus).toBe('idle')
  })

  it('cancels an execution returned after its debug run becomes stale and uses an input snapshot', async () => {
    const { api, raw } = createApi()
    const second = { ...project, id: 'project_2', name: 'Second project', rootPath: '/private/second' }
    raw.developer.listProjects.mockResolvedValue([project, second])
    let resolveRun!: (value: { executionId: string }) => void
    raw.developer.run.mockReturnValueOnce(new Promise((resolve) => { resolveRun = resolve }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    store.debugInput = { keyword: 'captured', nested: { value: 'captured' } }
    const run = store.runDebug()
    await vi.waitFor(() => expect(raw.developer.run).toHaveBeenCalled())
    ;(store.debugInput as { nested: { value: string } }).nested.value = 'mutated'
    await store.selectProject(second.id)
    resolveRun({ executionId: 'exec_late' })
    await run

    expect(raw.developer.run).toHaveBeenCalledWith({ projectId: project.id, input: { keyword: 'captured', nested: { value: 'captured' } } })
    expect(raw.executions.cancel).toHaveBeenCalledWith('exec_late')
    expect(store.debugExecutionId).toBe('')
    expect(store.debugStatus).toBe('idle')
  })

  it('ignores a validation error returned after its debug run becomes stale', async () => {
    const { api, raw } = createApi()
    const second = { ...project, id: 'project_2', name: 'Second project', rootPath: '/private/second' }
    raw.developer.listProjects.mockResolvedValue([project, second])
    let resolveRun!: (value: { validationError: string }) => void
    raw.developer.run.mockReturnValueOnce(new Promise((resolve) => { resolveRun = resolve }) as never)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useDeveloperStore()
    await store.loadProjects()
    const run = store.runDebug()
    await vi.waitFor(() => expect(raw.developer.run).toHaveBeenCalled())
    await store.selectProject(second.id)
    resolveRun({ validationError: '搜索关键词不能为空' })
    await run

    expect(store.debugError).toBe('')
    expect(store.debugStatus).toBe('idle')
  })
})
