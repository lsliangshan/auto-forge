<template>
  <div class="developer-files">
    <div class="project-actions">
      <el-input v-model="projectName" size="small" placeholder="新项目名称" aria-label="新项目名称" @keyup.enter="createProject" />
      <el-button size="small" type="primary" :disabled="!projectName.trim()" @click="createProject">创建</el-button>
      <el-button size="small" @click="developer.registerProject">导入</el-button>
    </div>
    <p v-if="developer.error" class="sidebar-error" role="alert">{{ developer.error }}</p>
    <p v-else-if="developer.loading" class="sidebar-state">正在加载项目…</p>
    <p v-else-if="!developer.projects.length" class="sidebar-state">尚无本地项目<br><small>创建或导入一个工作流项目</small></p>
    <div v-for="project in developer.projects" v-else :key="project.id" class="project-group">
      <button
        :class="['project-row', { active: project.id === developer.selectedProjectId }]"
        @click="developer.selectProject(project.id)"
        @contextmenu.prevent="openContext($event, project.id, '', 'root')"
      >
        <span class="af-truncate">{{ project.name }}</span><small>{{ project.status }}</small>
      </button>
      <ul v-if="project.id === developer.selectedProjectId" class="file-tree" role="tree">
        <li v-for="entry in visibleEntries" :key="`${entry.kind}:${entry.path}`" role="treeitem" :aria-expanded="entry.kind === 'directory' ? isExpanded(entry.path) : undefined">
          <button
            :class="['tree-row', { active: entry.kind === 'file' && entry.path === developer.selectedPath }]"
            :style="{ paddingLeft: `${8 + entry.depth * 14}px` }"
            :title="entry.path"
            :data-testid="`tree-entry-${entry.path}`"
            @click="activateEntry(entry)"
            @contextmenu.prevent="openContext($event, project.id, entry.path, entry.kind)"
          >
            <ArrowDown v-if="entry.kind === 'directory' && isExpanded(entry.path)" class="tree-chevron" />
            <ArrowRight v-else-if="entry.kind === 'directory'" class="tree-chevron" />
            <span v-else class="tree-chevron" />
            <FolderOpened v-if="entry.kind === 'directory' && isExpanded(entry.path)" />
            <Folder v-else-if="entry.kind === 'directory'" />
            <Document v-else />
            <span class="af-truncate">{{ entry.name }}</span>
          </button>
        </li>
      </ul>
    </div>
    <div
      v-if="context"
      class="tree-context-menu"
      role="menu"
      :style="{ left: `${context.x}px`, top: `${context.y}px` }"
      @click.stop
    >
      <button v-if="canCreate" data-action="create-file" role="menuitem" @click="createEntry('file')">新建文件</button>
      <button v-if="canCreate" data-action="create-directory" role="menuitem" @click="createEntry('directory')">新建目录</button>
      <button v-if="canMutate" data-action="rename" role="menuitem" @click="renameEntry">重命名</button>
      <button v-if="canMutate" class="danger" data-action="delete" role="menuitem" @click="deleteEntry">删除</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowDown, ArrowRight, Document, Folder, FolderOpened } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import { useDeveloperStore } from '../../stores/developer'

interface TreeEntry {
  path: string
  name: string
  kind: 'file' | 'directory'
  depth: number
}

interface TreeContext {
  projectId: string
  path: string
  kind: 'root' | 'file' | 'directory'
  x: number
  y: number
}

const developer = useDeveloperStore()
const projectName = ref('')
const expandedPathsByProject = ref<Record<string, string[]>>({})
const context = ref<TreeContext>()

const expandedPaths = computed({
  get: () => expandedPathsByProject.value[developer.selectedProjectId] ?? [],
  set: (paths: string[]) => {
    const projectId = developer.selectedProjectId
    if (projectId) expandedPathsByProject.value = { ...expandedPathsByProject.value, [projectId]: paths }
  },
})

function parentPath(path: string): string {
  const separator = path.lastIndexOf('/')
  return separator === -1 ? '' : path.slice(0, separator)
}

function entryName(path: string): string {
  return path.split('/').at(-1) ?? path
}

const visibleEntries = computed<TreeEntry[]>(() => {
  const project = developer.selectedProject
  if (!project) return []
  const entries = [
    ...project.directories.map((path) => ({ path, name: entryName(path), kind: 'directory' as const })),
    ...project.files.map((path) => ({ path, name: entryName(path), kind: 'file' as const })),
  ]
  const byParent = new Map<string, typeof entries>()
  for (const entry of entries) {
    const parent = parentPath(entry.path)
    const siblings = byParent.get(parent) ?? []
    siblings.push(entry)
    byParent.set(parent, siblings)
  }
  for (const siblings of byParent.values()) {
    siblings.sort((left, right) => left.kind === right.kind
      ? left.name.localeCompare(right.name)
      : left.kind === 'directory' ? -1 : 1)
  }
  const rows: TreeEntry[] = []
  const visit = (parent: string, depth: number) => {
    for (const entry of byParent.get(parent) ?? []) {
      rows.push({ ...entry, depth })
      if (entry.kind === 'directory' && isExpanded(entry.path)) visit(entry.path, depth + 1)
    }
  }
  visit('', 0)
  return rows
})

const canCreate = computed(() => context.value?.kind === 'root' || context.value?.kind === 'directory')
const canMutate = computed(() => Boolean(context.value && context.value.kind !== 'root' && !isProtected(context.value.path)))

watch(() => developer.selectedProjectId, (projectId) => {
  if (!projectId || Object.hasOwn(expandedPathsByProject.value, projectId)) return
  expandedPathsByProject.value = {
    ...expandedPathsByProject.value,
    [projectId]: [...(developer.selectedProject?.directories ?? [])],
  }
}, { immediate: true })

function isExpanded(path: string): boolean {
  return expandedPaths.value.includes(path)
}

function isProtected(path: string): boolean {
  return ['workflow.json', 'src/index.ts'].some((required) => required === path || required.startsWith(`${path}/`))
}

function activateEntry(entry: TreeEntry): void {
  if (entry.kind === 'file') {
    void developer.selectFile(entry.path)
    return
  }
  expandedPaths.value = isExpanded(entry.path)
    ? expandedPaths.value.filter((path) => path !== entry.path)
    : [...expandedPaths.value, entry.path]
}

function openContext(event: globalThis.MouseEvent, projectId: string, path: string, kind: TreeContext['kind']): void {
  context.value = { projectId, path, kind, x: event.clientX, y: event.clientY }
}

function closeContext(): void {
  context.value = undefined
}

async function promptName(title: string, inputValue = ''): Promise<string | undefined> {
  try {
    const result = await ElMessageBox.prompt(title, '项目文件', {
      inputValue,
      confirmButtonText: '确认',
      cancelButtonText: '取消',
      inputPattern: /^(?!\.{1,2}$)[^\\/\0]+$/,
      inputErrorMessage: '请输入不含路径分隔符的名称',
    })
    const value = typeof result.value === 'string' ? result.value.trim() : ''
    return value || undefined
  } catch {
    return undefined
  }
}

async function createProject(): Promise<void> {
  const name = projectName.value.trim()
  if (!name) return
  await developer.createProject(name)
  projectName.value = ''
}

async function createEntry(kind: 'file' | 'directory'): Promise<void> {
  const current = context.value
  if (!current) return
  const name = await promptName(kind === 'file' ? '输入文件名' : '输入目录名')
  if (!name) return
  await developer.createEntry(current.kind === 'directory' ? current.path : '', name, kind, current.projectId)
  if (current.projectId === developer.selectedProjectId && current.kind === 'directory' && !isExpanded(current.path)) {
    expandedPaths.value = [...expandedPaths.value, current.path]
  }
  closeContext()
}

async function renameEntry(): Promise<void> {
  const current = context.value
  if (!current || !canMutate.value) return
  const name = await promptName('输入新名称', entryName(current.path))
  if (!name || name === entryName(current.path)) return
  await developer.renameEntry(current.path, name, current.projectId)
  closeContext()
}

async function deleteEntry(): Promise<void> {
  const current = context.value
  if (!current || !canMutate.value) return
  try {
    await ElMessageBox.confirm(`确定删除“${current.path}”吗？目录会连同其内容一起删除。`, '删除项目文件', {
      confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning',
    })
  } catch {
    return
  }
  await developer.deleteEntry(current.path, current.projectId)
  closeContext()
}

onMounted(() => globalThis.document.addEventListener('click', closeContext))
onBeforeUnmount(() => globalThis.document.removeEventListener('click', closeContext))
</script>

<style scoped>
.developer-files { display: grid; gap: 8px; min-height: 0; }
.project-actions { display: grid; grid-template-columns: 1fr auto; gap: 6px; }.project-actions .el-button:last-child { grid-column: 1 / -1; margin: 0; }
.project-group { border-top: 1px solid var(--af-border); padding-top: 7px; }
.project-row, .tree-row { display: flex; width: 100%; align-items: center; border: 0; border-radius: 4px; color: var(--af-text); background: transparent; cursor: pointer; text-align: left; }
.project-row { justify-content: space-between; gap: 8px; padding: 7px; font-weight: 650; }.project-row small { color: var(--af-text-muted); font-size: 0.5625rem; text-transform: uppercase; }
.project-row.active, .tree-row.active { color: var(--af-cobalt); background: var(--af-cobalt-soft); }
.file-tree { display: grid; gap: 1px; margin: 4px 0 0; padding: 0; list-style: none; }
.tree-row { gap: 4px; min-height: 28px; padding-top: 5px; padding-right: 6px; padding-bottom: 5px; font-family: ui-monospace, monospace; font-size: 0.6875rem; }.tree-row:hover { background: var(--af-surface-muted); }.tree-row > svg { width: 14px; height: 14px; flex: none; }.tree-row > svg:not(.tree-chevron) { color: var(--af-text-muted); }.tree-chevron { width: 11px !important; height: 11px !important; flex: none; }
.tree-context-menu { position: fixed; z-index: 40; display: grid; min-width: 144px; overflow: hidden; border: 1px solid var(--af-border-strong); border-radius: 6px; padding: 4px; background: var(--af-surface); box-shadow: 0 8px 24px rgb(32 36 43 / 16%); }
.tree-context-menu button { border: 0; border-radius: 4px; padding: 7px 9px; color: var(--af-text); background: transparent; cursor: pointer; font-size: 0.75rem; text-align: left; }.tree-context-menu button:hover { background: var(--af-surface-muted); }.tree-context-menu button.danger { color: var(--af-danger); }
.sidebar-error { margin: 0; color: var(--af-danger); font-size: 0.75rem; }.sidebar-state { margin: 12px 0; color: var(--af-text-muted); font-size: 0.75rem; line-height: 1.6; text-align: center; }
</style>
