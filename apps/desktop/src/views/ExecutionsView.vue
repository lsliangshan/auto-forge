<template>
  <section class="page executions-page">
    <div class="page-toolbar">
      <div><strong>执行历史</strong><span>{{ execution.items.length }} 条</span></div><el-button
        :icon="Refresh"
        :loading="execution.loading"
        @click="execution.load()"
      >
        刷新
      </el-button>
    </div>
    <div
      v-if="execution.error"
      class="af-error"
      role="alert"
    >
      {{ execution.error }}
    </div>
    <div
      v-if="execution.loading && !execution.items.length"
      class="af-empty"
    >
      正在加载执行记录…
    </div>
    <div
      v-else-if="!execution.error && !execution.items.length"
      class="af-empty"
    >
      <div><h2>暂无执行记录</h2><p>工作流真实运行后，状态、耗时和结果会显示在这里。</p></div>
    </div>
    <div
      v-else
      class="execution-table"
      role="table"
      aria-label="执行记录"
    >
      <div
        class="table-header"
        role="row"
      >
        <span>状态</span><span>工作流</span><span>版本</span><span>创建时间</span><span>操作</span>
      </div>
      <button
        v-for="item in execution.items"
        :key="item.id"
        :class="['execution-row', { selected: execution.selectedId === item.id }]"
        role="row"
        @click="execution.select(item.id)"
      >
        <span><i :class="['af-status-dot', tone(item.status)]" />{{ label(item.status) }}</span><span class="af-truncate">{{ item.workflowId }}</span><span>{{ item.workflowVersion }}</span><time>{{ formatTime(item.createdAt) }}</time><span><el-button
          v-if="cancellable(item.status)"
          size="small"
          type="danger"
          text
          @click.stop="execution.cancel(item.id)"
        >取消</el-button><em v-else>查看</em></span>
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Refresh } from '@element-plus/icons-vue'
import type { ExecutionStatus } from '@autoforge/shared'
import { onMounted } from 'vue'
import { useExecutionStore } from '../stores/execution'

const execution = useExecutionStore()
onMounted(() => { execution.ensureSubscription(); if (!execution.items.length && !execution.loading) void execution.load() })
const label = (status: ExecutionStatus) => ({ queued: '排队中', awaiting_approval: '等待授权', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' })[status]
const tone = (status: ExecutionStatus) => status === 'completed' ? 'success' : ['failed', 'interrupted'].includes(status) ? 'danger' : ['queued', 'awaiting_approval', 'running'].includes(status) ? 'warning' : ''
const cancellable = (status: ExecutionStatus) => ['queued', 'awaiting_approval', 'running'].includes(status)
const formatTime = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
</script>

<style scoped>
.page { padding: 18px; }.page-toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }.page-toolbar > div { display: flex; gap: 9px; }.page-toolbar span { color: var(--af-text-muted); font-size: 12px; }
.execution-table { border: 1px solid var(--af-border); background: var(--af-surface); }.table-header, .execution-row { display: grid; grid-template-columns: 120px minmax(170px, 1fr) 90px 130px 58px; align-items: center; gap: 10px; padding: 10px 13px; }.table-header { color: var(--af-text-muted); background: var(--af-surface-muted); font-size: 11px; font-weight: 700; }.execution-row { width: 100%; border: 0; border-top: 1px solid var(--af-border); color: var(--af-text); background: white; cursor: pointer; font-size: 12px; text-align: left; }.execution-row:hover, .execution-row.selected { background: var(--af-cobalt-soft); }.execution-row > span:first-child { display: flex; align-items: center; gap: 7px; }.execution-row em { color: var(--af-cobalt); font-style: normal; }.af-empty h2 { color: var(--af-graphite); font-size: 18px; }.af-empty p { font-size: 13px; }
</style>
