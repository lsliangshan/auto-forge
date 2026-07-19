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
        <li
          v-for="conversation in chat.conversations"
          :key="conversation.id"
        >
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
      </ul>
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
      <div class="sidebar-state">
        Task 11 将在此显示本地项目与文件树。
      </div>
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
      <a href="#credential">OpenRouter 凭证</a>
      <a href="#model">默认模型</a>
      <a href="#appearance">外观与行为</a>
      <a href="#data">本地数据</a>
    </template>
  </aside>
</template>

<script setup lang="ts">
import { ChatDotRound, Delete, Edit, Plus, Search } from '@element-plus/icons-vue'
import type { ExecutionStatus } from '@autoforge/shared'
import { ElMessageBox } from 'element-plus'
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useChatStore } from '../stores/chat'
import { useExecutionStore } from '../stores/execution'
import { useWorkflowStore } from '../stores/workflow'

const route = useRoute()
const chat = useChatStore()
const workflow = useWorkflowStore()
const execution = useExecutionStore()
const workflowSearch = ref('')
const workflowSource = ref<'installed' | 'development' | ''>('')
const workflowEnabled = ref<'true' | 'false' | ''>('')
const executionSearch = ref('')
const executionStatus = ref<ExecutionStatus | ''>('')
const executionStatuses: { label: string; value: ExecutionStatus }[] = [
  { label: '排队中', value: 'queued' }, { label: '等待授权', value: 'awaiting_approval' },
  { label: '执行中', value: 'running' }, { label: '已完成', value: 'completed' },
  { label: '失败', value: 'failed' }, { label: '已取消', value: 'cancelled' }, { label: '已中断', value: 'interrupted' },
]

function applyWorkflowFilters() {
  void workflow.load({
    ...(workflowSearch.value.trim() ? { search: workflowSearch.value.trim() } : {}),
    ...(workflowSource.value ? { source: workflowSource.value } : {}),
    ...(workflowEnabled.value ? { enabled: workflowEnabled.value === 'true' } : {}),
  })
}
function applyExecutionFilters() {
  void execution.load({
    ...(executionSearch.value.trim() ? { search: executionSearch.value.trim() } : {}),
    ...(executionStatus.value ? { status: executionStatus.value } : {}),
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
})
</script>

<style scoped>
.context-sidebar { display: flex; width: 240px; min-width: 240px; height: 100%; flex-direction: column; gap: 10px; border-right: 1px solid var(--af-border); padding: 14px 12px; background: var(--af-surface-muted); }
.sidebar-toolbar { display: flex; min-height: 28px; align-items: center; justify-content: space-between; }
.context-list { min-height: 0; margin: 0 -4px; padding: 0 4px; overflow: auto; list-style: none; }
.context-list li + li { margin-top: 2px; }
.conversation-row { display: grid; grid-template-columns: minmax(0, 1fr) 26px 26px; align-items: center; border-radius: 5px; }
.conversation-row:hover { background: #edf0f4; }.conversation-row.active { color: #174ea6; background: var(--af-cobalt-soft); }
.conversation-select { display: flex; min-width: 0; align-items: center; gap: 8px; border: 0; padding: 9px 8px; color: inherit; background: transparent; cursor: pointer; text-align: left; }
.conversation-action { display: grid; width: 24px; height: 24px; place-items: center; border: 0; border-radius: 4px; color: var(--af-text-muted); background: transparent; cursor: pointer; opacity: 0; }
.conversation-row:hover .conversation-action, .conversation-action:focus-visible { opacity: 1; }.conversation-action:hover { color: var(--af-cobalt); background: white; }.conversation-action.danger:hover { color: var(--af-danger); }
.sidebar-state { margin-top: 20px; color: var(--af-text-muted); font-size: 12px; line-height: 1.6; text-align: center; }
.sidebar-state small { color: #8a939f; }.sidebar-error { color: var(--af-danger); font-size: 12px; }
.field-label { margin-top: 4px; color: var(--af-text-muted); font-size: 11px; font-weight: 650; }
a { border-radius: 5px; padding: 8px 9px; color: var(--af-text); font-size: 13px; text-decoration: none; }
a:hover { color: var(--af-cobalt); background: var(--af-cobalt-soft); }
</style>
