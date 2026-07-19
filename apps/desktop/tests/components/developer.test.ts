import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopAPI, DeveloperProject, ExecutionEvent, ValidationResult } from '@autoforge/shared'
import CodeEditor from '../../src/components/developer/CodeEditor.vue'
import DebugPanel from '../../src/components/developer/DebugPanel.vue'
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
  const disposeEditor = vi.fn()
  const setModelMarkers = vi.fn()
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
    models, disposeEditor, setModelMarkers,
    reset() { models.clear(); activeModel = null; changeListener = () => undefined; disposeEditor.mockClear(); setModelMarkers.mockClear() },
    change(value: string) { if (!activeModel) throw new Error('No active Monaco model'); activeModel.value = value; changeListener() },
    api: {
      Uri: { parse: (value: string) => ({ toString: () => value }) },
      editor: {
        create: vi.fn(() => ({
          getModel: () => activeModel,
          setModel: (model: Model) => { activeModel = model },
          onDidChangeModelContent: (listener: () => void) => { changeListener = listener; return { dispose: vi.fn() } },
          updateOptions: vi.fn(), layout: vi.fn(), dispose: disposeEditor,
        })),
        createModel,
        getModel: (uri: { toString(): string }) => models.get(uri.toString()),
        setModelLanguage: (model: Model, language: string) => { model.language = language },
        setModelMarkers,
      },
    },
  }
})

vi.mock('monaco-editor/esm/vs/editor/editor.api.js', () => monacoHarness.api)
vi.mock('monaco-editor/esm/vs/language/json/monaco.contribution.js', () => ({}))
vi.mock('monaco-editor/esm/vs/language/css/monaco.contribution.js', () => ({}))
vi.mock('monaco-editor/esm/vs/language/typescript/monaco.contribution.js', () => ({}))

const project: DeveloperProject = {
  id: 'project_1', name: 'Baidu search', rootPath: '/private/project', status: 'new',
  files: ['src/index.ts', 'workflow.json'], updatedAt: '2026-07-19T00:00:00.000Z',
}

function createApi() {
  let executionListener: ((event: ExecutionEvent) => void) | undefined
  const api = {
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
      writeFile: vi.fn().mockResolvedValue(undefined), build: vi.fn().mockResolvedValue({ ...project, status: 'ready' }),
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
})
