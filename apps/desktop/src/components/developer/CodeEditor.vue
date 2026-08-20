<template>
  <section class="code-editor" data-testid="monaco-editor">
    <div class="editor-tabs" role="tablist" aria-label="打开的文件">
      <div v-for="path in developer.currentOpenPaths" :key="path" :class="['editor-tab', { active: path === developer.selectedPath, dirty: tabSaveState(path) === 'dirty' || tabSaveState(path) === 'error' }]" :data-testid="`editor-tab-${path}`">
        <button class="tab-select af-truncate" role="tab" :aria-selected="path === developer.selectedPath" @click="developer.selectFile(path)">{{ fileName(path) }}</button>
        <button class="tab-close" :aria-label="`关闭 ${fileName(path)}`" :data-testid="`close-tab-${path}`" @click="developer.closeFile(path)">×</button>
      </div>
    </div>
    <div class="editor-status">
      <span class="af-truncate">{{ developer.selectedPath || '未选择文件' }}</span>
      <div class="editor-tools">
        <button data-testid="editor-find" title="查找" aria-label="查找" @click="runEditorAction('actions.find')"><Search /></button>
        <button data-testid="editor-replace" title="替换" aria-label="替换" @click="runEditorAction('editor.action.startFindReplaceAction')"><EditPen /></button>
        <span :class="['save-state', `is-${developer.saveState}`]">{{ saveLabel }}</span>
      </div>
    </div>
    <div v-if="developer.currentBuffer?.loading" class="editor-safe-state">正在加载文件…</div>
    <div v-else-if="developer.fileUnavailableReason" class="editor-safe-state" role="alert">
      <strong>无法编辑此文件</strong>
      <span>{{ developer.fileUnavailableReason }}</span>
    </div>
    <div v-else-if="!developer.selectedPath" class="editor-safe-state">请从左侧选择一个文本文件。</div>
    <div v-show="developer.selectedPath && !developer.fileUnavailableReason" ref="container" class="monaco-host" />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditPen, Search } from '@element-plus/icons-vue'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import 'monaco-editor/esm/vs/language/json/monaco.contribution.js'
import 'monaco-editor/esm/vs/language/css/monaco.contribution.js'
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution.js'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import TypeScriptWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { useDeveloperStore } from '../../stores/developer'

const workers = new Map<string, globalThis.Worker>()

function createWorker(label: string): globalThis.Worker {
  const kind = label === 'json' ? 'json'
    : ['css', 'scss', 'less'].includes(label) ? 'css'
      : ['typescript', 'javascript'].includes(label) ? 'typescript'
        : 'editor'
  const existing = workers.get(kind)
  if (existing) return existing
  const worker = kind === 'json' ? new JsonWorker()
    : kind === 'css' ? new CssWorker()
      : kind === 'typescript' ? new TypeScriptWorker()
        : new EditorWorker()
  workers.set(kind, worker)
  return worker
}

;(globalThis as typeof globalThis & { MonacoEnvironment?: unknown }).MonacoEnvironment = {
  getWorker: (moduleId: string, label: string) => { void moduleId; return createWorker(label) },
}

const developer = useDeveloperStore()
const container = ref<globalThis.HTMLElement>()
const ownedModels = new Set<monaco.editor.ITextModel>()
let editor: monaco.editor.IStandaloneCodeEditor | undefined
let contentListener: monaco.IDisposable | undefined
let suppressChange = false

const modelKey = computed(() => developer.selectedProjectId && developer.selectedPath
  ? `${developer.selectedProjectId}/${developer.selectedPath}` : '')
const saveLabel = computed(() => ({ idle: '未修改', dirty: '未保存', saving: '保存中…', saved: '已保存', error: '保存失败' })[developer.saveState])

function fileName(path: string): string {
  return path.split('/').at(-1) ?? path
}

function tabSaveState(path: string) {
  return Object.values(developer.files).find((buffer) => buffer.projectId === developer.selectedProjectId && buffer.path === path)?.saveState
}

function languageFor(path: string): string {
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript'
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'javascript'
  if (path.endsWith('.json')) return 'json'
  if (path.endsWith('.css')) return 'css'
  if (path.endsWith('.scss')) return 'scss'
  if (path.endsWith('.less')) return 'less'
  if (path.endsWith('.md')) return 'markdown'
  return 'plaintext'
}

function modelUri(projectId: string, path: string): monaco.Uri {
  return monaco.Uri.parse(`autoforge://project/${encodeURIComponent(projectId)}/${path.split('/').map(encodeURIComponent).join('/')}`)
}

function ensureEditor() {
  if (editor || !container.value || !developer.selectedPath || developer.fileUnavailableReason || !developer.currentBuffer?.loaded) return
  editor = monaco.editor.create(container.value, {
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    lineHeight: 21,
    scrollBeyondLastLine: false,
    tabSize: 2,
    theme: 'vs',
  })
  contentListener = editor.onDidChangeModelContent(() => {
    if (suppressChange) return
    developer.editCurrent(editor?.getModel()?.getValue() ?? '')
  })
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void developer.saveCurrent() })
}

function runEditorAction(actionId: string): void {
  void editor?.getAction(actionId)?.run()
}

async function activateModel() {
  await nextTick()
  ensureEditor()
  if (!editor || !developer.currentBuffer?.loaded || developer.fileUnavailableReason) return
  const uri = modelUri(developer.selectedProjectId, developer.selectedPath)
  let model = monaco.editor.getModel(uri)
  if (!model) {
    model = monaco.editor.createModel(developer.currentContent, languageFor(developer.selectedPath), uri)
    ownedModels.add(model)
  } else {
    monaco.editor.setModelLanguage(model, languageFor(developer.selectedPath))
  }
  suppressChange = true
  if (model.getValue() !== developer.currentContent) model.setValue(developer.currentContent)
  editor.setModel(model)
  suppressChange = false
  applyMarkers()
}

function applyMarkers() {
  const model = editor?.getModel()
  if (!model) return
  const path = developer.selectedPath
  const diagnostics = developer.diagnostics.filter((diagnostic) => diagnostic.path === path
    || (path === 'workflow.json' && diagnostic.path.startsWith('/')))
  monaco.editor.setModelMarkers(model, 'autoforge-main-validation', diagnostics.map((diagnostic) => ({
    severity: diagnostic.severity === 'error' ? 8 : 4,
    message: diagnostic.message,
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: Math.max(2, model.getLineMaxColumn(1)),
  })))
}

watch(modelKey, () => { void activateModel() })
watch(() => developer.currentBuffer?.loaded, () => { void activateModel() })
watch(() => developer.currentContent, (content) => {
  const model = editor?.getModel()
  if (!model || model.uri.toString() !== modelUri(developer.selectedProjectId, developer.selectedPath).toString() || model.getValue() === content) return
  suppressChange = true
  model.setValue(content)
  suppressChange = false
})
watch(() => developer.diagnostics, applyMarkers, { deep: true })

onMounted(() => {
  void activateModel()
})
onBeforeUnmount(() => {
  void developer.flushPendingSaves()
  contentListener?.dispose()
  editor?.dispose()
  for (const model of ownedModels) model.dispose()
  ownedModels.clear()
})
</script>

<style scoped>
.code-editor { display: flex; min-height: 0; height: 100%; flex-direction: column; background: #fff; }
.editor-tabs { display: flex; min-height: 35px; overflow-x: auto; border-bottom: 1px solid var(--af-border); background: var(--af-surface-muted); }
.editor-tab { display: flex; min-width: 112px; max-width: 220px; align-items: center; border-right: 1px solid var(--af-border); color: var(--af-text-muted); background: var(--af-surface-muted); }
.editor-tab.active { color: var(--af-text); background: var(--af-surface); box-shadow: inset 0 2px var(--af-cobalt); }
.tab-select, .tab-close { border: 0; color: inherit; background: transparent; cursor: pointer; }
.tab-select { display: flex; min-width: 0; flex: 1; align-items: center; gap: 6px; padding: 9px 6px 8px 10px; text-align: left; }.editor-tab.dirty .tab-select::before { width: 6px; height: 6px; flex: none; border-radius: 50%; background: var(--af-danger); content: ''; }
.tab-close { margin-right: 4px; border-radius: 3px; padding: 2px 5px; font-size: 14px; line-height: 1; }.tab-close:hover { background: var(--af-border); }
.editor-status { display: flex; min-height: 34px; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--af-border); padding: 0 12px; color: var(--af-text-muted); font-family: ui-monospace, monospace; font-size: 11px; }
.editor-tools { display: flex; align-items: center; gap: 5px; }.editor-tools button { display: grid; width: 24px; height: 24px; place-items: center; border: 0; border-radius: 4px; padding: 5px; color: var(--af-text-muted); background: transparent; cursor: pointer; }.editor-tools button:hover { color: var(--af-cobalt); background: var(--af-cobalt-soft); }.editor-tools svg { width: 14px; height: 14px; }
.save-state { white-space: nowrap; }.is-dirty, .is-error { color: var(--af-danger); }.is-saving { color: var(--af-warning); }.is-saved { color: var(--af-success); }
.monaco-host { min-height: 280px; flex: 1; }
.editor-safe-state { display: grid; min-height: 280px; flex: 1; place-content: center; gap: 6px; padding: 24px; color: var(--af-text-muted); text-align: center; }
.editor-safe-state strong { color: var(--af-graphite); }
</style>
