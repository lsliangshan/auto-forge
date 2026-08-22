<template>
  <section
    class="workflow-status"
    data-testid="workflow-status"
    aria-live="polite"
  >
    <div class="status-heading">
      <span :class="['af-status-dot', statusTone]" />
      <strong>{{ statusLabel }} {{ block.workflowName }}</strong>
      <span class="execution-index">{{ block.executionIndex }} / {{ block.executionLimit }}</span>
    </div>
    <div class="status-meta">
      <span>{{ block.city ?? '不限城市' }}</span>
      <span>{{ block.workflowVersion }}</span>
      <span>{{ block.source === 'development' ? '开发版本' : '已安装' }}</span>
    </div>
    <p
      v-if="statusMessage"
      data-testid="workflow-status-message"
      :class="{ 'status-error': block.status === 'failed' }"
    >
      {{ statusMessage }}
    </p>
    <div class="status-actions">
      <el-button
        size="small"
        data-testid="open-workflow-execution"
        @click="execution.select(block.executionId)"
      >
        在检查器中查看
      </el-button>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { ChatBlock } from '@autoforge/shared'
import { computed } from 'vue'
import { useExecutionStore } from '../../stores/execution'

type WorkflowStatusBlock = Extract<ChatBlock, { type: 'workflow_status' }>
const props = defineProps<{ block: WorkflowStatusBlock }>()
const execution = useExecutionStore()

const statusLabel = computed(() => ({
  queued: '准备调用',
  awaiting_approval: '等待授权',
  running: '正在调用',
  completed: '调用完成',
  failed: '调用失败',
  cancelled: '已取消调用',
  interrupted: '调用已中断',
})[props.block.status])
const statusTone = computed(() => props.block.status === 'completed'
  ? 'success'
  : ['failed', 'interrupted'].includes(props.block.status)
    ? 'danger'
    : ['queued', 'awaiting_approval', 'running'].includes(props.block.status) ? 'warning' : '')
const statusMessage = computed(() => props.block.errorCode === 'RESULT_TOO_LARGE'
  ? '执行完成，结果未提供给模型'
  : props.block.errorSummary ?? '')
</script>

<style scoped>
.workflow-status { max-width: 640px; border: 1px solid var(--af-border); border-left: 3px solid var(--af-cobalt); padding: 13px 14px; background: var(--af-surface-muted); }
.status-heading, .status-meta, .status-actions { display: flex; align-items: center; }
.status-heading { gap: 8px; }.status-heading strong { min-width: 0; overflow-wrap: anywhere; }
.execution-index { margin-left: auto; color: var(--af-text-muted); font-size: 12px; white-space: nowrap; }
.status-meta { flex-wrap: wrap; gap: 6px 12px; margin-top: 8px; color: var(--af-text-muted); font-size: 11px; }
.status-meta span + span::before { margin-right: 12px; content: '·'; }
p { margin: 8px 0 0; color: var(--af-text-muted); font-size: 12px; }.status-error { color: var(--af-danger); }
.status-actions { justify-content: flex-end; margin-top: 10px; }
</style>
