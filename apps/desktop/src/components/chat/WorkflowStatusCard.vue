<template>
  <section
    :class="['workflow-status', 'af-operation-card', `tone-${statusTone}`, { 'is-collapsed': !expanded }]"
    data-testid="workflow-status"
    aria-live="polite"
  >
    <header class="af-operation-card-header">
      <span
        :class="['af-operation-marker', `tone-${statusTone}`]"
        aria-hidden="true"
      >
        <WorkflowLogo :logo="block.logo">
          <el-icon :class="{ 'is-loading': block.status === 'running' }">
            <component :is="statusIcon" />
          </el-icon>
        </WorkflowLogo>
      </span>
      <div class="af-operation-title">
        <span class="af-operation-eyebrow">工作流 · 第 {{ block.executionIndex }} 次调用 · 上限 {{ block.executionLimit }} 次</span>
        <strong>{{ block.workflowName }}</strong>
      </div>
      <div class="af-operation-summary">
        <span
          class="af-operation-badge"
          data-testid="workflow-status-badge"
        >{{ statusLabel }}</span>
        <button
          type="button"
          class="af-operation-toggle"
          data-testid="toggle-workflow-details"
          :aria-expanded="expanded"
          :aria-controls="contentId"
          :aria-label="expanded ? '收起工作流详情' : '展开工作流详情'"
          @click="expanded = !expanded"
        >
          <el-icon><ArrowDown /></el-icon>
        </button>
      </div>
    </header>
    <div
      v-if="expanded"
      :id="contentId"
      class="af-operation-content"
      data-testid="workflow-status-content"
    >
      <ol
        class="workflow-progress"
        data-testid="workflow-progress"
        aria-label="工作流执行进度"
      >
        <li
          v-for="(stage, index) in workflowStages"
          :key="stage"
          :class="['workflow-progress-step', progressStepClass(index)]"
        >
          <span class="workflow-progress-node" />
          <span>{{ stage }}</span>
        </li>
      </ol>
      <div class="af-operation-meta">
        <span class="af-operation-chip">{{ block.city ?? '不限城市' }}</span>
        <span class="af-operation-chip">v{{ block.workflowVersion }}</span>
        <span class="af-operation-chip">{{ block.source === 'development' ? '开发版本' : '已安装' }}</span>
      </div>
      <p
        v-if="statusMessage"
        data-testid="workflow-status-message"
        :class="['af-operation-alert', { 'status-error': block.status === 'failed' }]"
      >
        <el-icon aria-hidden="true">
          <Warning />
        </el-icon><span>{{ statusMessage }}</span>
      </p>
      <footer
        v-if="block.executionAvailable"
        class="af-operation-footer"
      >
        <button
          type="button"
          class="af-operation-link"
          data-testid="open-workflow-execution"
          @click="execution.select(block.executionId)"
        >
          查看执行详情 <el-icon><ArrowRight /></el-icon>
        </button>
      </footer>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ArrowDown, ArrowRight, Check, Clock, CloseBold, Loading, Remove, Warning } from '@element-plus/icons-vue'
import type { ChatBlock } from '@autoforge/shared'
import { computed, ref, watch } from 'vue'
import { displayError } from '../../services/desktop-api'
import { useExecutionStore } from '../../stores/execution'
import WorkflowLogo from '../WorkflowLogo.vue'

type WorkflowStatusBlock = Extract<ChatBlock, { type: 'workflow_status' }>
const props = defineProps<{ block: WorkflowStatusBlock }>()
const execution = useExecutionStore()
const contentId = computed(() => `workflow-status-content-${props.block.blockId}`)
const shouldExpand = (block: WorkflowStatusBlock) => block.status !== 'completed'
  || Boolean(block.errorCode || block.errorSummary)
const expanded = ref(shouldExpand(props.block))

watch(() => [props.block.status, props.block.errorCode, props.block.errorSummary], () => {
  expanded.value = shouldExpand(props.block)
})

const statusLabel = computed(() => ({
  queued: '准备中',
  awaiting_approval: '等待授权',
  running: '进行中',
  completed: '已完成',
  failed: '未完成',
  cancelled: '已取消',
  interrupted: '已中断',
})[props.block.status])
const statusTone = computed(() => ({
  queued: 'neutral',
  awaiting_approval: 'warning',
  running: 'active',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  interrupted: 'warning',
})[props.block.status])
const statusIcon = computed(() => ({
  queued: Clock,
  awaiting_approval: Clock,
  running: Loading,
  completed: Check,
  failed: CloseBold,
  cancelled: Remove,
  interrupted: Warning,
})[props.block.status])
const workflowStages = ['匹配工作流', '检查授权', '执行任务', '返回结果']
const progressIndex = computed(() => ({
  queued: 0,
  awaiting_approval: 1,
  running: 2,
  completed: workflowStages.length,
  failed: 2,
  cancelled: 1,
  interrupted: 2,
})[props.block.status])

function progressStepClass(index: number): string {
  if (props.block.status === 'completed' || index < progressIndex.value) return 'is-complete'
  if (index > progressIndex.value) return 'is-pending'
  if (props.block.status === 'failed') return 'is-failed'
  if (props.block.status === 'cancelled') return 'is-cancelled'
  if (props.block.status === 'interrupted') return 'is-interrupted'
  return 'is-current'
}
const statusMessage = computed(() => props.block.errorCode === 'RESULT_TOO_LARGE'
  ? '执行完成，结果未提供给模型'
  : props.block.errorCode === 'CAPABILITY_SCOPE_DENIED'
    ? displayError({ code: props.block.errorCode })
  : props.block.errorSummary ?? '')
</script>

<style scoped>
.workflow-progress { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 2px 0 12px; padding: 0; list-style: none; }
.workflow-progress-step { position: relative; display: grid; min-width: 0; justify-items: start; gap: 5px; color: var(--af-text-muted); font-size: 0.5625rem; line-height: 1.35; }
.workflow-progress-step::before { position: absolute; top: 5px; right: calc(100% - 1px); width: calc(100% - 10px); height: 1px; background: var(--af-border); content: ''; }
.workflow-progress-step:first-child::before { display: none; }
.workflow-progress-node { position: relative; z-index: 1; width: 10px; height: 10px; border: 2px solid var(--af-border-strong); border-radius: 50%; background: var(--af-surface); }
.workflow-progress-step.is-complete { color: var(--af-text); }
.workflow-progress-step.is-complete::before { background: color-mix(in srgb, var(--af-success) 45%, var(--af-border)); }
.workflow-progress-step.is-complete .workflow-progress-node { border-color: var(--af-success); background: var(--af-success); box-shadow: inset 0 0 0 2px var(--af-surface); }
.workflow-progress-step.is-current { color: var(--af-cobalt); font-weight: 650; }
.workflow-progress-step.is-current .workflow-progress-node { border-color: var(--af-cobalt); box-shadow: 0 0 0 4px var(--af-cobalt-soft); }
.workflow-progress-step.is-failed { color: var(--af-danger); font-weight: 650; }
.workflow-progress-step.is-failed .workflow-progress-node { border-color: var(--af-danger); background: var(--af-danger); box-shadow: 0 0 0 4px var(--af-danger-soft); }
.workflow-progress-step.is-interrupted { color: var(--af-warning); font-weight: 650; }
.workflow-progress-step.is-interrupted .workflow-progress-node { border-color: var(--af-warning); box-shadow: 0 0 0 4px var(--af-warning-soft); }
.workflow-progress-step.is-cancelled { color: var(--af-text-muted); font-weight: 650; }
.workflow-progress-step.is-cancelled .workflow-progress-node { border-color: var(--af-text-muted); background: var(--af-surface-muted); }
.status-error { color: var(--af-danger); }
</style>
