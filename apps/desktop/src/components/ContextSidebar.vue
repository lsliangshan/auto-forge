<template>
  <aside
    class="context-sidebar"
    aria-label="页面上下文"
  >
    <template v-if="route.name === 'chat'">
      <div class="sidebar-toolbar">
        <span class="af-panel-heading">会话</span>
        <el-button
          size="small"
          type="primary"
          :icon="Plus"
          aria-label="新建会话"
          @click="chat.createConversation"
        >
          新建
        </el-button>
      </div>
      <el-input
        v-model="conversationSearch"
        clearable
        placeholder="搜索会话"
        aria-label="搜索会话"
      />
      <div
        v-if="chat.loading"
        class="sidebar-state"
      >
        正在加载会话…
      </div>
      <div
        v-else-if="chat.error"
        class="sidebar-error"
        role="alert"
      >
        {{ chat.error }}
      </div>
      <div
        v-else-if="!chat.conversations.length"
        class="sidebar-state"
      >
        尚无会话<br><small>新建会话后开始聊天</small>
      </div>
      <ul
        v-else
        class="context-list af-scrollbar"
      >
        <template v-for="group in conversationGroups" :key="group.label">
          <li class="conversation-group">{{ group.label }}</li>
          <li v-for="conversation in group.items" :key="conversation.id">
          <div :class="['conversation-row', { active: chat.selectedConversationId === conversation.id }]">
            <button
              class="conversation-select"
              @click="chat.selectConversation(conversation.id)"
            >
              <el-icon><ChatDotRound /></el-icon><span class="af-truncate">{{ conversation.title }}</span>
            </button>
            <button
              class="conversation-action"
              :aria-label="`重命名${conversation.title}`"
              @click="renameConversation(conversation.id, conversation.title)"
            >
              <el-icon><Edit /></el-icon>
            </button>
            <button
              class="conversation-action danger"
              :aria-label="`删除${conversation.title}`"
              @click="deleteConversation(conversation.id, conversation.title)"
            >
              <el-icon><Delete /></el-icon>
            </button>
          </div>
          </li>
        </template>
      </ul>
    </template>

    <template v-else-if="route.name === 'knowledge'">
      <div class="sidebar-toolbar">
        <span class="af-panel-heading">知识库</span>
      </div>
      <div class="knowledge-create">
        <el-input
          v-model="knowledgeBaseName"
          aria-label="新知识库名称"
          maxlength="200"
          placeholder="新知识库名称"
          @keyup.enter="createKnowledgeBase"
        />
        <el-button
          data-testid="knowledge-create"
          :icon="Plus"
          :disabled="!knowledgeBaseName.trim() || !knowledge.canCreateBase || knowledge.operationPending"
          @click="createKnowledgeBase"
        >创建</el-button>
      </div>
      <div v-if="knowledge.loading" class="sidebar-state">正在加载…</div>
      <div v-else-if="knowledge.error" class="sidebar-error" role="alert">{{ knowledge.error }}</div>
      <div v-else-if="!knowledge.bases.length" class="sidebar-state">
        尚无可用知识库
      </div>
      <ul v-else class="context-list af-scrollbar" aria-label="知识库列表" role="listbox">
        <li v-for="base in knowledge.bases" :key="base.id">
          <button
            :data-testid="`knowledge-base-${base.id}`"
            type="button"
            role="option"
            :aria-selected="knowledge.selectedBaseId === base.id"
            :class="['knowledge-base-row', { active: knowledge.selectedBaseId === base.id }]"
            @click="knowledge.selectBase(base.id)"
          >
            <span class="af-truncate">{{ base.name }}</span>
            <small>{{ base.documentCount }} 个文件 · {{ baseStatusLabel(base) }}</small>
          </button>
        </li>
      </ul>
      <div v-if="knowledge.selectedBase" class="knowledge-base-actions">
        <el-button size="small" :disabled="!knowledge.canExport || knowledge.operationPending" @click="knowledge.exportSelectedBase">导出</el-button>
        <el-button
          data-testid="knowledge-recycle-base"
          size="small"
          type="danger"
          plain
          :disabled="!knowledge.canRecycle || knowledge.operationPending"
          @click="recycleKnowledgeBase"
        >回收</el-button>
        <el-button
          data-testid="knowledge-purge-base"
          size="small"
          type="danger"
          :disabled="!knowledge.canPurge || knowledge.operationPending"
          @click="purgeKnowledgeBase"
        >永久删除</el-button>
      </div>
    </template>

    <template v-else-if="route.name === 'workflows'">
      <div class="sidebar-toolbar">
        <span class="af-panel-heading">筛选工作流</span>
      </div>
      <el-input
        v-model="workflowSearch"
        clearable
        placeholder="搜索名称或说明"
        aria-label="搜索工作流"
        @keyup.enter="applyWorkflowFilters"
      />
      <label
        class="field-label"
        for="workflow-category"
      >类别</label>
      <el-select
        id="workflow-category"
        v-model="workflowCategory"
        placeholder="全部类别"
        clearable
        @change="applyWorkflowFilters"
      ><el-option v-for="category in workflowCategories" :key="category" :label="category" :value="category" /></el-select>
      <label
        class="field-label"
        for="workflow-source"
      >来源</label>
      <el-select
        id="workflow-source"
        v-model="workflowSource"
        placeholder="全部来源"
        clearable
        @change="applyWorkflowFilters"
      >
        <el-option
          label="已安装"
          value="installed"
        /><el-option
          label="开发中"
          value="development"
        />
      </el-select>
      <label
        class="field-label"
        for="workflow-state"
      >状态</label>
      <el-select
        id="workflow-state"
        v-model="workflowEnabled"
        placeholder="全部状态"
        clearable
        @change="applyWorkflowFilters"
      >
        <el-option
          label="已启用"
          value="true"
        /><el-option
          label="已停用"
          value="false"
        />
      </el-select>
      <el-button
        :icon="Search"
        @click="applyWorkflowFilters"
      >
        应用筛选
      </el-button>
    </template>

    <template v-else-if="route.name === 'developer'">
      <div class="sidebar-toolbar">
        <span class="af-panel-heading">项目与文件</span>
      </div>
      <FileTree />
    </template>

    <template v-else-if="route.name === 'executions'">
      <div class="sidebar-toolbar">
        <span class="af-panel-heading">筛选执行记录</span>
      </div>
      <el-input
        v-model="executionSearch"
        clearable
        placeholder="工作流或执行 ID"
        aria-label="搜索执行记录"
      />
      <el-input
        v-model="executionWorkflowId"
        clearable
        placeholder="精确工作流 ID"
        aria-label="筛选工作流 ID"
      />
      <label
        class="field-label"
        for="execution-status"
      >状态</label>
      <el-select
        id="execution-status"
        v-model="executionStatus"
        placeholder="全部状态"
        clearable
      >
        <el-option
          v-for="item in executionStatuses"
          :key="item.value"
          :label="item.label"
          :value="item.value"
        />
      </el-select>
      <label class="field-label">开始时间</label><input v-model="executionFrom" class="native-filter" type="datetime-local">
      <label class="field-label">结束时间</label><input v-model="executionTo" class="native-filter" type="datetime-local">
      <el-button
        :icon="Search"
        @click="applyExecutionFilters"
      >
        应用筛选
      </el-button>
    </template>

    <template v-else>
      <div class="sidebar-toolbar">
        <span class="af-panel-heading">设置</span>
      </div>
      <button
        v-for="section in settingsSections"
        :key="section.id"
        class="settings-section-link"
        :class="{ active: activeSettingsSection === section.id }"
        type="button"
        data-testid="settings-section-nav-item"
        :aria-current="activeSettingsSection === section.id ? 'location' : undefined"
        @click="scrollToSettingsSection(section.id)"
      >
        {{ section.label }}
      </button>
    </template>
  </aside>
</template>

<script setup lang="ts">
import { ChatDotRound, Delete, Edit, Plus, Search } from '@element-plus/icons-vue'
import type { ExecutionStatus, KnowledgeBase } from '@autoforge/shared'
import { ElMessageBox } from 'element-plus'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useChatStore } from '../stores/chat'
import { useExecutionStore } from '../stores/execution'
import { useKnowledgeStore } from '../stores/knowledge'
import { useWorkflowStore } from '../stores/workflow'
import FileTree from './developer/FileTree.vue'

const route = useRoute()
const chat = useChatStore()
const workflow = useWorkflowStore()
const execution = useExecutionStore()
const knowledge = useKnowledgeStore()
const knowledgeBaseName = ref('')
const baseStatusLabel = (base: KnowledgeBase) => {
  if (base.status === 'processing') return base.kind === 'cloud' ? '同步中' : '本地处理中'
  if (base.status === 'read_only') return '只读'
  if (base.status === 'failed') return '失败'
  if (base.status === 'paused') return '已暂停'
  if (base.status === 'recycled') return '已回收'
  return base.kind === 'cloud' ? '已同步' : '仅本地'
}
async function createKnowledgeBase() {
  const name = knowledgeBaseName.value.trim()
  if (!name) return
  await knowledge.createBase(name)
  if (!knowledge.operationError) knowledgeBaseName.value = ''
}
async function recycleKnowledgeBase() {
  const base = knowledge.selectedBase
  if (!base) return
  try {
    await ElMessageBox.confirm(`确认将知识库“${base.name}”及其文件移入回收站？`, '回收知识库', {
      type: 'warning', confirmButtonText: '确认回收', cancelButtonText: '取消',
    })
    await knowledge.recycleSelectedBase()
  } catch { /* Cancellation does not mutate knowledge state. */ }
}
async function purgeKnowledgeBase() {
  const base = knowledge.selectedBase
  if (!base) return
  try {
    await ElMessageBox.confirm(`确认永久删除知识库“${base.name}”及其文件？此操作无法恢复。`, '永久删除知识库', {
      type: 'error', confirmButtonText: '永久删除', cancelButtonText: '取消',
    })
    await knowledge.purgeSelectedBase()
  } catch { /* Cancellation does not mutate knowledge state. */ }
}
const conversationSearch = ref('')
const conversationGroups = computed(() => {
  const search = conversationSearch.value.trim().toLocaleLowerCase()
  const filtered = chat.conversations.filter(({ title }) => !search || title.toLocaleLowerCase().includes(search))
  const today = new Date().toDateString()
  const groups = new Map<string, typeof filtered>()
  for (const item of filtered) {
    const label = new Date(item.updatedAt).toDateString() === today ? '今天' : '更早'
    groups.set(label, [...(groups.get(label) ?? []), item])
  }
  return [...groups].map(([label, items]) => ({ label, items }))
})
const workflowSearch = ref('')
const workflowSource = ref<'installed' | 'development' | ''>('')
const workflowEnabled = ref<'true' | 'false' | ''>('')
const workflowCategory = ref('')
const workflowCategories = computed(() => [...new Set(workflow.items.map(({ category }) => category))].sort())
const executionSearch = ref('')
const executionWorkflowId = ref('')
const executionFrom = ref('')
const executionTo = ref('')
const executionStatus = ref<ExecutionStatus | ''>('')
const executionStatuses: { label: string; value: ExecutionStatus }[] = [
  { label: '排队中', value: 'queued' }, { label: '等待授权', value: 'awaiting_approval' },
  { label: '执行中', value: 'running' }, { label: '已完成', value: 'completed' },
  { label: '失败', value: 'failed' }, { label: '已取消', value: 'cancelled' }, { label: '已中断', value: 'interrupted' },
]
const settingsSections = [
  { id: 'provider', label: '大模型供应商' },
  { id: 'model', label: '默认模型' },
  { id: 'billing', label: '用量与消费' },
  { id: 'proxy', label: 'VPN 代理' },
  { id: 'appearance', label: '外观与行为' },
  { id: 'data', label: '本地数据' },
  { id: 'permissions', label: '已保存授权' },
  { id: 'about', label: '关于 AutoForge' },
] as const
type SettingsSectionId = typeof settingsSections[number]['id']
const activeSettingsSection = ref<SettingsSectionId>(settingsSections[0].id)
let settingsScrollContainer: globalThis.HTMLElement | null = null

function scrollToSettingsSection(id: SettingsSectionId) {
  activeSettingsSection.value = id
  globalThis.document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function syncActiveSettingsSection() {
  if (!settingsScrollContainer) return
  const { scrollTop, scrollHeight, clientHeight } = settingsScrollContainer
  if (scrollTop > 0 && scrollTop + clientHeight >= scrollHeight - 1) {
    activeSettingsSection.value = settingsSections[settingsSections.length - 1].id
    return
  }
  const decisionLine = settingsScrollContainer.getBoundingClientRect().top + 24
  let activeId: SettingsSectionId = settingsSections[0].id
  for (const section of settingsSections) {
    const element = globalThis.document.getElementById(section.id)
    if (!element) continue
    if (element.getBoundingClientRect().top > decisionLine) break
    activeId = section.id
  }
  activeSettingsSection.value = activeId
}

function detachSettingsScrollSync() {
  settingsScrollContainer?.removeEventListener('scroll', syncActiveSettingsSection)
  settingsScrollContainer = null
}

function setupSettingsScrollSync() {
  detachSettingsScrollSync()
  activeSettingsSection.value = settingsSections[0].id
  if (route.name !== 'settings') return
  void nextTick(() => {
    if (route.name !== 'settings') return
    settingsScrollContainer = globalThis.document.querySelector<globalThis.HTMLElement>('.workspace-content')
    settingsScrollContainer?.addEventListener('scroll', syncActiveSettingsSection, { passive: true })
    syncActiveSettingsSection()
  })
}

function applyWorkflowFilters() {
  void workflow.load({
    ...(workflowSearch.value.trim() ? { search: workflowSearch.value.trim() } : {}),
    ...(workflowSource.value ? { source: workflowSource.value } : {}),
    ...(workflowCategory.value ? { category: workflowCategory.value } : {}),
    ...(workflowEnabled.value ? { enabled: workflowEnabled.value === 'true' } : {}),
  })
}
function applyExecutionFilters() {
  void execution.load({
    ...(executionSearch.value.trim() ? { search: executionSearch.value.trim() } : {}),
    ...(executionStatus.value ? { status: executionStatus.value } : {}),
    ...(executionWorkflowId.value.trim() ? { workflowId: executionWorkflowId.value.trim() } : {}),
    ...(executionFrom.value ? { from: new Date(executionFrom.value).toISOString() } : {}),
    ...(executionTo.value ? { to: new Date(executionTo.value).toISOString() } : {}),
  })
}
async function renameConversation(id: string, title: string) {
  try {
    const result = await ElMessageBox.prompt('输入新的会话名称', '重命名会话', {
      inputValue: title, inputPattern: /\S+/, inputErrorMessage: '会话名称不能为空',
      confirmButtonText: '保存', cancelButtonText: '取消',
    })
    await chat.renameConversation(id, result.value)
  } catch { /* Cancelled prompts do not change local data. */ }
}
async function deleteConversation(id: string, title: string) {
  try {
    await ElMessageBox.confirm(`确认删除“${title}”及其消息记录？`, '删除会话', {
      type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消',
    })
    await chat.deleteConversation(id)
  } catch { /* Cancelled confirmations do not change local data. */ }
}

onMounted(() => {
  if (route.name === 'chat' && !chat.conversations.length && !chat.loading) void chat.loadConversations()
  setupSettingsScrollSync()
})
watch(() => route.name, setupSettingsScrollSync)
onBeforeUnmount(detachSettingsScrollSync)
</script>

<style scoped>
.context-sidebar { display: flex; width: 240px; min-width: 240px; height: 100%; flex-direction: column; gap: 10px; border-right: 1px solid var(--af-border); padding: 14px 12px; background: var(--af-surface-muted); }
.sidebar-toolbar { display: flex; min-height: 28px; align-items: center; justify-content: space-between; }
.context-list { min-height: 0; margin: 0 -4px; padding: 0 4px; overflow: auto; list-style: none; }
.context-list li + li { margin-top: 2px; }
.conversation-group { padding: 9px 7px 3px; color: var(--af-text-muted); font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
.conversation-row { display: grid; grid-template-columns: minmax(0, 1fr) 26px 26px; align-items: center; border-radius: 5px; }
.conversation-row:hover { background: var(--af-hover); }.conversation-row.active { color: var(--af-cobalt); background: var(--af-cobalt-soft); }
.conversation-select { display: flex; min-width: 0; align-items: center; gap: 8px; border: 0; padding: 9px 8px; color: inherit; background: transparent; cursor: pointer; text-align: left; }
.conversation-action { display: grid; width: 24px; height: 24px; place-items: center; border: 0; border-radius: 4px; color: var(--af-text-muted); background: transparent; cursor: pointer; opacity: 0; }
.conversation-row:hover .conversation-action, .conversation-action:focus-visible { opacity: 1; }.conversation-action:hover { color: var(--af-cobalt); background: var(--af-surface); }.conversation-action.danger:hover { color: var(--af-danger); }
.sidebar-state { margin-top: 20px; color: var(--af-text-muted); font-size: 12px; line-height: 1.6; text-align: center; }
.sidebar-state small { color: var(--af-text-muted); }.sidebar-error { color: var(--af-danger); font-size: 12px; }
.field-label { margin-top: 4px; color: var(--af-text-muted); font-size: 11px; font-weight: 650; }
.native-filter { width: 100%; border: 1px solid var(--af-border-strong); border-radius: 4px; padding: 7px 8px; color: var(--af-text); background: var(--af-surface); font-size: 11px; }
.settings-section-link { width: 100%; border: 0; border-radius: 5px; padding: 8px 9px; color: var(--af-text); background: transparent; font: inherit; font-size: 13px; cursor: pointer; text-align: left; }
.settings-section-link:hover, .settings-section-link.active { color: var(--af-cobalt); background: var(--af-cobalt-soft); }
.settings-section-link.active { font-weight: 650; }
.knowledge-create { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; }
.knowledge-base-row { display: grid; width: 100%; gap: 3px; border: 0; border-radius: 6px; padding: 9px 8px; color: var(--af-text); background: transparent; cursor: pointer; text-align: left; }
.knowledge-base-row:hover { background: var(--af-hover); }.knowledge-base-row.active { color: var(--af-cobalt); background: var(--af-cobalt-soft); }.knowledge-base-row small { color: var(--af-text-muted); font-size: 10px; }
.knowledge-base-actions { display: flex; gap: 6px; border-top: 1px solid var(--af-border); padding-top: 10px; }
</style>
