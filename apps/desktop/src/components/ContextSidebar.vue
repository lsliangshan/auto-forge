<template>
  <aside
    class="context-sidebar"
    aria-label="页面上下文"
  >
    <template v-if="route.name === 'chat'">
      <div class="sidebar-toolbar conversation-toolbar">
        <span class="af-panel-heading">会话</span>
        <el-button
          class="conversation-new-button"
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
        class="conversation-search"
        clearable
        placeholder="搜索会话"
        aria-label="搜索会话"
      />
      <div
        v-if="chat.syncWarningSince"
        class="durable-sync-warning"
        data-testid="durable-sync-warning"
        role="alert"
      >
        <span>同步已停滞超过 24 小时</span>
        <button
          type="button"
          data-testid="retry-durable-sync"
          :disabled="chat.retryingAllSync"
          :aria-busy="chat.retryingAllSync"
          @click="chat.retrySync()"
        >
          {{ chat.retryingAllSync ? '正在重试…' : '立即重试' }}
        </button>
      </div>
      <div
        v-if="chat.syncRetryError"
        class="sidebar-error sync-retry-error"
        data-testid="sync-retry-error"
        role="alert"
      >
        {{ chat.syncRetryError }}
      </div>
      <div
        v-if="chat.conversationListError"
        class="sidebar-error"
        role="alert"
      >
        {{ chat.conversationListError }}
      </div>
      <div
        v-if="chat.loading"
        class="sidebar-state"
      >
        正在加载会话…
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
        <template
          v-for="group in conversationGroups"
          :key="group.label"
        >
          <li class="conversation-group">
            {{ group.label }}
          </li>
          <li
            v-for="conversation in group.items"
            :key="conversation.id"
          >
            <div :class="['conversation-row', { active: chat.selectedConversationId === conversation.id }]">
              <button
                class="conversation-select"
                @click="chat.selectConversation(conversation.id)"
              >
                <el-icon><ChatDotRound /></el-icon><span class="af-truncate">{{ conversation.title }}</span>
                <span
                  v-if="conversation.syncState !== 'synced'"
                  class="conversation-sync-status"
                  :class="`is-${conversation.syncState}`"
                  data-testid="conversation-sync-status"
                  role="status"
                  :aria-label="syncStateLabel[conversation.syncState]"
                />
              </button>
              <div :class="['conversation-actions', { 'has-retry': conversation.syncState === 'failed' }]">
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
                <button
                  v-if="conversation.syncState === 'failed'"
                  class="conversation-action sync-retry"
                  data-testid="retry-conversation-sync"
                  :disabled="Boolean(chat.retryingSyncByConversation[conversation.id])"
                  :aria-busy="Boolean(chat.retryingSyncByConversation[conversation.id])"
                  :aria-label="chat.retryingSyncByConversation[conversation.id]
                    ? `正在重试同步${conversation.title}`
                    : `重试同步${conversation.title}`"
                  @click="chat.retrySync(conversation.id)"
                >
                  <el-icon :class="{ 'is-loading': chat.retryingSyncByConversation[conversation.id] }">
                    <Refresh />
                  </el-icon>
                </button>
              </div>
            </div>
          </li>
        </template>
        <li
          v-if="chat.nextConversationCursor"
          class="conversation-more"
        >
          <button
            type="button"
            @click="chat.loadMoreConversations"
          >
            加载更多会话
          </button>
        </li>
      </ul>
    </template>

    <template v-else-if="route.name === 'workflows'">
      <div class="workflow-filter-panel">
        <div class="workflow-filter-heading">
          <span class="workflow-filter-icon"><el-icon><Filter /></el-icon></span>
          <div>
            <span class="af-panel-heading">筛选工作流</span>
            <small>按能力与适用范围快速定位</small>
          </div>
          <span
            v-if="workflowActiveFilterCount"
            class="workflow-filter-count"
          >{{ workflowActiveFilterCount }}</span>
        </div>
        <el-input
          v-model="workflowSearch"
          class="workflow-filter-search"
          clearable
          :prefix-icon="Search"
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
          class="workflow-filter-control"
          placeholder="全部类别"
          clearable
          @change="applyWorkflowFilters"
        >
          <el-option
            v-for="category in workflowCategories"
            :key="category"
            :label="category"
            :value="category"
          />
        </el-select>
        <label
          class="field-label"
          for="workflow-city"
        >城市</label>
        <el-select
          id="workflow-city"
          v-model="workflowCity"
          class="workflow-filter-control"
          placeholder="全部城市"
          clearable
          @change="applyWorkflowFilters"
        >
          <el-option
            v-for="city in workflowCities"
            :key="city"
            :label="city"
            :value="city"
          />
        </el-select>
        <label
          class="field-label"
          for="workflow-source"
        >来源</label>
        <el-select
          id="workflow-source"
          v-model="workflowSource"
          class="workflow-filter-control"
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
          class="workflow-filter-control"
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
        <div class="workflow-filter-actions">
          <el-button @click="resetWorkflowFilters">
            重置
          </el-button>
          <el-button
            type="primary"
            :icon="Search"
            @click="applyWorkflowFilters"
          >
            应用筛选
          </el-button>
        </div>
      </div>
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
import { ChatDotRound, Delete, Edit, Filter, Plus, Refresh, Search } from '@element-plus/icons-vue'
import type { ExecutionStatus, SyncState } from '@autoforge/shared'
import { ElMessageBox } from 'element-plus'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useChatStore } from '../stores/chat'
import { useExecutionStore } from '../stores/execution'
import { useWorkflowStore } from '../stores/workflow'
import FileTree from './developer/FileTree.vue'

const route = useRoute()
const chat = useChatStore()
const workflow = useWorkflowStore()
const execution = useExecutionStore()
const conversationSearch = ref('')
const conversationGroups = computed(() => {
  const search = conversationSearch.value.trim().toLocaleLowerCase()
  const filtered = chat.conversations.filter(({ title }) => !search || title.toLocaleLowerCase().includes(search))
  const today = new Date().toDateString()
  const groups = new Map<string, typeof filtered>()
  for (const item of filtered) {
    const label = new Date(item.lastActivityAt).toDateString() === today ? '今天' : '更早'
    groups.set(label, [...(groups.get(label) ?? []), item])
  }
  return [...groups].map(([label, items]) => ({ label, items }))
})
const syncStateLabel: Record<SyncState, string> = {
  synced: '同步完成', pending: '等待同步', syncing: '正在同步', failed: '同步失败',
}
const workflowSearch = ref('')
const workflowSource = ref<'installed' | 'development' | ''>('')
const workflowEnabled = ref<'true' | 'false' | ''>('')
const workflowCategory = ref('')
const workflowCity = ref('')
const workflowCategories = computed(() => [...new Set(workflow.items.map(({ category }) => category))].sort())
const workflowCities = ref<string[]>([])
const workflowActiveFilterCount = computed(() => Object.values(workflow.query)
  .filter((value) => value !== undefined && value !== '').length)
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
  { id: 'developer', label: '开发者' },
  { id: 'data', label: '本地数据' },
  { id: 'permissions', label: '已保存授权' },
  { id: 'about', label: '关于 AutoForge' },
] as const
type SettingsSectionId = typeof settingsSections[number]['id']
const activeSettingsSection = ref<SettingsSectionId>(settingsSections[0].id)
let settingsScrollContainer: ReturnType<typeof globalThis.document.querySelector> = null

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
    settingsScrollContainer = globalThis.document.querySelector('.workspace-content')
    settingsScrollContainer?.addEventListener('scroll', syncActiveSettingsSection, { passive: true })
    syncActiveSettingsSection()
  })
}

function applyWorkflowFilters() {
  void workflow.load({
    ...(workflowSearch.value.trim() ? { search: workflowSearch.value.trim() } : {}),
    ...(workflowSource.value ? { source: workflowSource.value } : {}),
    ...(workflowCategory.value ? { category: workflowCategory.value } : {}),
    ...(workflowCity.value ? { city: workflowCity.value } : {}),
    ...(workflowEnabled.value ? { enabled: workflowEnabled.value === 'true' } : {}),
  })
}
function resetWorkflowFilters() {
  workflowSearch.value = ''
  workflowSource.value = ''
  workflowCategory.value = ''
  workflowCity.value = ''
  workflowEnabled.value = ''
  void workflow.load({})
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
      customClass: 'conversation-message-box conversation-rename-message-box',
      modalClass: 'conversation-message-box-overlay',
    })
    await chat.renameConversation(id, result.value)
  } catch { /* Cancelled prompts do not change local data. */ }
}
async function deleteConversation(id: string, title: string) {
  try {
    await ElMessageBox.confirm(`确认删除“${title}”及其消息记录？`, '删除会话', {
      type: 'error', confirmButtonText: '确认删除', cancelButtonText: '取消',
      confirmButtonType: 'danger',
      customClass: 'conversation-message-box conversation-delete-message-box',
      modalClass: 'conversation-message-box-overlay',
    })
    await chat.deleteConversation(id)
  } catch { /* Cancelled confirmations do not change local data. */ }
}

onMounted(() => {
  if (route.name === 'chat' && !chat.conversations.length && !chat.loading) void chat.loadConversations()
  setupSettingsScrollSync()
})
watch(() => workflow.items, (items) => {
  const hasActiveQuery = Object.keys(workflow.query).length > 0
  const cities = new Set(hasActiveQuery ? workflowCities.value : [])
  for (const item of items) {
    for (const city of item.cities) cities.add(city)
  }
  workflowCities.value = [...cities].sort((left, right) => left.localeCompare(right, 'zh-CN'))
}, { immediate: true })
watch(() => route.name, setupSettingsScrollSync)
onBeforeUnmount(detachSettingsScrollSync)
</script>

<style scoped>
.context-sidebar { display: flex; width: var(--af-context-sidebar-width); min-width: var(--af-context-sidebar-width); height: 100%; flex-direction: column; gap: 10px; border-right: 1px solid var(--af-border); padding: 14px 8px 14px 12px; background: var(--af-surface-muted); }
.sidebar-toolbar { display: flex; min-height: 28px; align-items: center; justify-content: space-between; }
.conversation-toolbar { min-height: 32px; padding: 0 2px; }
.conversation-new-button { min-height: 30px; border-radius: 8px; padding: 6px 10px; font-weight: 650; box-shadow: 0 5px 14px color-mix(in srgb, var(--af-cobalt) 18%, transparent); }
.conversation-search :deep(.el-input__wrapper) { min-height: 36px; border-radius: 9px; background: var(--af-surface); box-shadow: 0 0 0 1px var(--af-border) inset; transition: box-shadow .16s ease; }
.conversation-search :deep(.el-input__wrapper:hover) { box-shadow: 0 0 0 1px var(--af-border-strong) inset; }
.conversation-search :deep(.el-input__wrapper.is-focus) { box-shadow: 0 0 0 1px var(--af-cobalt) inset, var(--af-focus); }
.context-list { min-height: 0; margin: 0 -4px; padding: 0 4px 8px; overflow: auto; list-style: none; }
.context-list li + li { margin-top: 3px; }
.conversation-group { display: flex; align-items: center; gap: 8px; padding: 12px 8px 5px; color: var(--af-text-muted); font-size: 0.625rem; font-weight: 700; letter-spacing: .08em; }
.conversation-group::after { height: 1px; flex: 1; background: linear-gradient(90deg, var(--af-border), transparent); content: ''; }
.conversation-row { position: relative; display: flex; min-height: 44px; align-items: center; overflow: hidden; border: 1px solid transparent; border-radius: 10px; transition: border-color .16s ease, background-color .16s ease, box-shadow .16s ease; }
.conversation-row:hover { border-color: color-mix(in srgb, var(--af-border) 82%, transparent); background: var(--af-surface); box-shadow: 0 5px 14px rgb(32 36 43 / 5%); }.conversation-row.active { border-color: color-mix(in srgb, var(--af-cobalt) 16%, var(--af-border)); color: var(--af-cobalt); background: linear-gradient(90deg, var(--af-cobalt-soft), color-mix(in srgb, var(--af-cobalt-soft) 58%, var(--af-surface))); box-shadow: inset 3px 0 var(--af-cobalt), 0 5px 16px color-mix(in srgb, var(--af-cobalt) 7%, transparent); }
.conversation-select { display: flex; width: 100%; min-width: 0; min-height: 42px; flex: 1 1 auto; align-items: center; gap: 9px; border: 0; padding: 7px 8px 7px 10px; color: inherit; background: transparent; cursor: pointer; text-align: left; }
.conversation-select > .el-icon { display: grid; width: 26px; height: 26px; flex: 0 0 26px; place-items: center; border: 1px solid var(--af-border); border-radius: 8px; color: var(--af-text-muted); background: var(--af-surface); transition: border-color .16s ease, color .16s ease, background-color .16s ease; }
.conversation-row:hover .conversation-select > .el-icon { border-color: var(--af-border-strong); color: var(--af-text); }.conversation-row.active .conversation-select > .el-icon { border-color: color-mix(in srgb, var(--af-cobalt) 24%, var(--af-border)); color: var(--af-cobalt); background: color-mix(in srgb, var(--af-cobalt-soft) 72%, var(--af-surface)); }
.conversation-select .af-truncate { font-size: 0.75rem; font-weight: 560; line-height: 1.35; }.conversation-row.active .conversation-select .af-truncate { font-weight: 680; }
.conversation-sync-status { width: 7px; height: 7px; flex: 0 0 auto; border: 2px solid var(--af-surface); border-radius: 50%; background: var(--af-text-muted); box-shadow: 0 0 0 1px var(--af-border); }
.conversation-sync-status.is-pending { background: var(--af-warning); }.conversation-sync-status.is-syncing { background: var(--af-cobalt); box-shadow: 0 0 0 2px var(--af-cobalt-soft); }.conversation-sync-status.is-failed { background: var(--af-danger); box-shadow: 0 0 0 1px color-mix(in srgb, var(--af-danger) 35%, var(--af-border)); }
.durable-sync-warning { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; color: var(--af-warning-strong); background: var(--af-warning-soft); border-radius: 8px; font-size: 0.75rem; }
.durable-sync-warning button { flex: none; color: inherit; background: none; border: 0; padding: 0; font: inherit; text-decoration: underline; white-space: nowrap; cursor: pointer; }
.durable-sync-warning button:disabled { cursor: default; opacity: .65; }
.conversation-actions { display: none; flex: 0 0 auto; align-items: center; gap: 2px; margin-right: 5px; border: 1px solid var(--af-border); border-radius: 9px; padding: 2px; background: var(--af-surface); box-shadow: 0 4px 12px rgb(32 36 43 / 8%); }
.conversation-row:hover .conversation-actions, .conversation-row:focus-within .conversation-actions, .conversation-actions.has-retry { display: flex; }
.conversation-action { display: none; width: 26px; height: 26px; flex: 0 0 26px; place-items: center; border: 0; border-radius: 7px; color: var(--af-text-muted); background: transparent; cursor: pointer; transition: color .14s ease, background-color .14s ease; }
.conversation-row:hover .conversation-action, .conversation-row:focus-within .conversation-action, .conversation-action.sync-retry { display: grid; }.conversation-action:hover { color: var(--af-cobalt); background: var(--af-cobalt-soft); }.conversation-action.danger:hover { color: var(--af-danger); background: var(--af-danger-soft); }.conversation-action.sync-retry { color: var(--af-danger); }.conversation-action:disabled { cursor: wait; opacity: .6; }
.conversation-more { padding: 8px 4px; text-align: center; }.conversation-more button { border: 0; color: var(--af-cobalt); background: transparent; font: inherit; font-size: 0.6875rem; cursor: pointer; }
.sidebar-state { margin-top: 20px; color: var(--af-text-muted); font-size: 0.75rem; line-height: 1.6; text-align: center; }
.sidebar-state small { color: var(--af-text-muted); }.sidebar-error { color: var(--af-danger); font-size: 0.75rem; }
.sync-retry-error { padding: 0 8px; }
.field-label { margin-top: 4px; color: var(--af-text-muted); font-size: 0.6875rem; font-weight: 650; }
.workflow-filter-panel { display: flex; flex-direction: column; gap: 8px; border: 1px solid color-mix(in srgb, var(--af-border) 86%, transparent); border-radius: 14px; padding: 12px; background: color-mix(in srgb, var(--af-surface) 82%, transparent); box-shadow: 0 8px 24px rgb(32 36 43 / 4%); }
.workflow-filter-heading { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; align-items: center; gap: 9px; margin-bottom: 3px; }
.workflow-filter-heading > div { display: grid; gap: 2px; }.workflow-filter-heading small { color: var(--af-text-muted); font-size: 0.5625rem; line-height: 1.35; }
.workflow-filter-icon { display: grid; width: 34px; height: 34px; place-items: center; border: 1px solid color-mix(in srgb, var(--af-cobalt) 18%, var(--af-border)); border-radius: 10px; color: var(--af-cobalt); background: var(--af-cobalt-soft); }
.workflow-filter-count { display: grid; min-width: 22px; height: 22px; place-items: center; border-radius: 999px; color: var(--af-cobalt); background: var(--af-cobalt-soft); font-size: 0.625rem; font-weight: 750; }
.workflow-filter-search :deep(.el-input__wrapper), .workflow-filter-control :deep(.el-select__wrapper) { min-height: 38px; border-radius: 9px; background: var(--af-surface); box-shadow: 0 0 0 1px var(--af-border) inset; transition: box-shadow .16s ease, background-color .16s ease; }
.workflow-filter-search :deep(.el-input__wrapper:hover), .workflow-filter-control :deep(.el-select__wrapper:hover) { box-shadow: 0 0 0 1px var(--af-border-strong) inset; }
.workflow-filter-search :deep(.el-input__wrapper.is-focus), .workflow-filter-control :deep(.el-select__wrapper.is-focused) { box-shadow: 0 0 0 1px var(--af-cobalt) inset, var(--af-focus); }
.workflow-filter-panel .field-label { margin-top: 3px; padding-left: 2px; color: var(--af-text); font-size: 0.625rem; letter-spacing: .02em; }
.workflow-filter-actions { display: grid; grid-template-columns: .75fr 1.25fr; gap: 8px; margin-top: 7px; padding-top: 11px; border-top: 1px solid var(--af-border); }.workflow-filter-actions .el-button { width: 100%; min-height: 36px; margin: 0; border-radius: 9px; font-weight: 650; }.workflow-filter-actions .el-button--primary { box-shadow: 0 5px 14px color-mix(in srgb, var(--af-cobalt) 18%, transparent); }
.native-filter { width: 100%; border: 1px solid var(--af-border-strong); border-radius: 4px; padding: 7px 8px; color: var(--af-text); background: var(--af-surface); font-size: 0.6875rem; }
.settings-section-link { width: 100%; min-height: 38px; border: 0; border-radius: 9px; padding: 9px 11px; color: var(--af-text); background: transparent; font: inherit; font-size: 0.8125rem; line-height: 1.4; cursor: pointer; text-align: left; transition: color .16s ease, background-color .16s ease, box-shadow .16s ease; }
.settings-section-link:hover, .settings-section-link.active { color: var(--af-cobalt); background: var(--af-cobalt-soft); }
.settings-section-link.active { padding-left: 14px; box-shadow: inset 3px 0 var(--af-cobalt); font-weight: 680; }
:global(.conversation-message-box-overlay) { background: rgb(15 23 42 / 50%); backdrop-filter: blur(4px); }
:global(.conversation-message-box) { --el-messagebox-width: 500px; --el-messagebox-border-radius: 18px; --el-messagebox-padding-primary: 0; border: 1px solid var(--af-border); background: var(--af-surface); box-shadow: 0 28px 80px rgb(15 23 42 / 28%), 0 8px 24px rgb(15 23 42 / 12%); }
:global(.conversation-message-box .el-message-box__header) { min-height: 70px; border-bottom: 1px solid var(--af-border); padding: 23px 64px 19px 24px; }
:global(.conversation-rename-message-box .el-message-box__header) { background: linear-gradient(135deg, var(--af-surface) 58%, color-mix(in srgb, var(--af-cobalt-soft) 76%, var(--af-surface))); }
:global(.conversation-delete-message-box) { border-color: color-mix(in srgb, var(--af-danger) 16%, var(--af-border)); }
:global(.conversation-delete-message-box .el-message-box__header) { border-bottom-color: color-mix(in srgb, var(--af-danger) 12%, var(--af-border)); background: linear-gradient(135deg, var(--af-surface) 58%, color-mix(in srgb, var(--af-danger-soft) 78%, var(--af-surface))); }
:global(.conversation-message-box .el-message-box__title) { color: var(--af-graphite); font-size: 1.0625rem; font-weight: 720; line-height: 1.35; }
:global(.conversation-message-box .el-message-box__headerbtn) { top: 14px; right: 14px; width: 36px; height: 36px; border-radius: 10px; transition: color .15s ease, background .15s ease; }
:global(.conversation-message-box .el-message-box__headerbtn:hover) { background: var(--af-surface-muted); }
:global(.conversation-message-box .el-message-box__headerbtn .el-message-box__close) { color: var(--af-text-muted); }
:global(.conversation-rename-message-box .el-message-box__headerbtn:hover .el-message-box__close) { color: var(--af-cobalt); }
:global(.conversation-delete-message-box .el-message-box__headerbtn:hover) { background: color-mix(in srgb, var(--af-danger-soft) 72%, var(--af-surface)); }
:global(.conversation-delete-message-box .el-message-box__headerbtn:hover .el-message-box__close) { color: var(--af-danger); }
:global(.conversation-message-box .el-message-box__content) { padding: 22px 24px 24px; color: var(--af-text); }
:global(.conversation-message-box .el-message-box__message p) { color: var(--af-text-muted); font-size: 0.8125rem; line-height: 1.6; }
:global(.conversation-rename-message-box .el-message-box__input) { padding-top: 12px; }
:global(.conversation-rename-message-box .el-input__wrapper) { min-height: 42px; border-radius: 10px; background: var(--af-surface); box-shadow: 0 0 0 1px var(--af-border-strong) inset; transition: box-shadow .16s ease; }
:global(.conversation-rename-message-box .el-input__wrapper:hover) { box-shadow: 0 0 0 1px var(--af-cobalt) inset; }
:global(.conversation-rename-message-box .el-input__wrapper.is-focus) { box-shadow: 0 0 0 1px var(--af-cobalt) inset, var(--af-focus); }
:global(.conversation-rename-message-box .el-message-box__errormsg) { margin-top: 7px; color: var(--af-danger); font-size: 0.6875rem; }
:global(.conversation-delete-message-box .el-message-box__container) { align-items: flex-start; gap: 14px; }
:global(.conversation-delete-message-box .el-message-box__status) { display: grid; width: 44px; height: 44px; flex: 0 0 44px; place-items: center; border: 1px solid color-mix(in srgb, var(--af-danger) 18%, var(--af-border)); border-radius: 13px; color: var(--af-danger); background: var(--af-danger-soft); font-size: 1.25rem; }
:global(.conversation-delete-message-box .el-message-box__message) { padding-top: 1px; }
:global(.conversation-delete-message-box .el-message-box__message p) { color: var(--af-text); }
:global(.conversation-message-box .el-message-box__btns) { gap: 9px; border-top: 1px solid var(--af-border); padding: 14px 24px; background: color-mix(in srgb, var(--af-surface-muted) 86%, var(--af-surface)); }
:global(.conversation-message-box .el-message-box__btns .el-button) { min-width: 84px; min-height: 38px; margin-left: 0; border-radius: 9px; padding: 8px 15px; font-size: 0.75rem; font-weight: 680; }
:global(.conversation-message-box .el-message-box__btns .el-button--primary) { box-shadow: 0 5px 14px color-mix(in srgb, var(--af-cobalt) 20%, transparent); }
:global(.conversation-message-box .el-message-box__btns .el-button--danger) { min-width: 104px; box-shadow: 0 5px 14px color-mix(in srgb, var(--af-danger) 22%, transparent); }
</style>
