<template>
  <section
    :class="['workflow-provenance', 'af-operation-card', `tone-${statusTone}`, { 'is-collapsed': !expanded }]"
    data-testid="workflow-provenance"
    :data-entry-count="block.entries.length"
  >
    <header class="af-operation-card-header">
      <span
        class="af-operation-marker"
        aria-hidden="true"
      >
        <el-icon><component :is="statusIcon" /></el-icon>
      </span>
      <div class="af-operation-title">
        <span class="af-operation-eyebrow">{{ eyebrowLabel }}</span>
        <strong>{{ first.workflowName }}</strong>
      </div>
      <div class="af-operation-summary">
        <span
          class="af-operation-badge"
          data-testid="workflow-provenance-badge"
        >{{ badgeLabel }}</span>
        <button
          type="button"
          class="af-operation-toggle"
          data-testid="toggle-workflow-provenance"
          :aria-expanded="expanded"
          :aria-controls="contentId"
          :aria-label="expanded ? '收起已使用工作流' : '展开已使用工作流'"
          @click="expanded = !expanded"
        >
          <el-icon><ArrowDown /></el-icon>
        </button>
      </div>
    </header>

    <div
      v-if="expanded"
      :id="contentId"
      class="af-operation-content provenance-list"
      data-testid="workflow-provenance-content"
    >
      <div
        v-for="entry in block.entries"
        :key="entry.executionId"
        class="provenance-entry"
      >
        <span
          :class="['provenance-entry-marker', `tone-${entryTone(entry.status)}`]"
          aria-hidden="true"
        />
        <div class="provenance-entry-copy">
          <strong>{{ entry.workflowName }}</strong>
          <span>{{ entry.city ?? '不限城市' }} · {{ statusLabel(entry.status) }}</span>
        </div>
        <button
          type="button"
          class="af-operation-link"
          :data-testid="`open-provenance-execution-${entry.executionId}`"
          @click="execution.select(entry.executionId)"
        >
          查看执行
        </button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ArrowDown, Check, CloseBold, Loading, Remove, Warning } from '@element-plus/icons-vue'
import type { ChatBlock, ExecutionStatus } from '@autoforge/shared'
import { computed, ref } from 'vue'
import { useExecutionStore } from '../../stores/execution'

type WorkflowProvenanceBlock = Extract<ChatBlock, { type: 'workflow_provenance' }>
const props = defineProps<{ block: WorkflowProvenanceBlock }>()
const execution = useExecutionStore()
const expanded = ref(false)
const first = computed(() => props.block.entries[0]!)
const contentId = computed(() => `workflow-provenance-content-${props.block.blockId}`)

const statusTone = computed(() => {
  const statuses = props.block.entries.map((entry) => entry.status)
  if (statuses.includes('failed')) return 'danger'
  if (statuses.some((status) => status === 'awaiting_approval' || status === 'interrupted')) return 'warning'
  if (statuses.some((status) => status === 'queued' || status === 'running')) return 'active'
  if (statuses.every((status) => status === 'completed')) return 'success'
  return 'neutral'
})
const statusIcon = computed(() => ({
  active: Loading,
  warning: Warning,
  success: Check,
  danger: CloseBold,
  neutral: Remove,
})[statusTone.value])
const eyebrowLabel = computed(() => props.block.entries.length === 1
  ? `已使用工作流 · ${first.value.city ?? '不限城市'}`
  : `已使用 ${props.block.entries.length} 个工作流`)
const badgeLabel = computed(() => {
  if (props.block.entries.length === 1) return statusLabel(first.value.status)
  if (statusTone.value === 'danger') return '含未完成项'
  if (statusTone.value === 'active' || statusTone.value === 'warning') return '执行记录更新中'
  if (statusTone.value === 'success') return `${props.block.entries.length} 项已完成`
  return `${props.block.entries.length} 项记录`
})

function statusLabel(status: ExecutionStatus): string {
  return ({
    queued: '排队中', awaiting_approval: '等待授权', running: '执行中', completed: '已完成',
    failed: '失败', cancelled: '已取消', interrupted: '已中断',
  })[status]
}

function entryTone(status: ExecutionStatus): string {
  return ({
    queued: 'active', awaiting_approval: 'warning', running: 'active', completed: 'success',
    failed: 'danger', cancelled: 'neutral', interrupted: 'warning',
  })[status]
}
</script>

<style scoped>
.provenance-list { display: grid; gap: 0; padding-bottom: 12px; }
.provenance-entry { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; border-top: 1px solid var(--af-border); padding: 10px 0; }
.provenance-entry:first-child { border-top: 0; padding-top: 2px; }
.provenance-entry-marker { width: 7px; height: 7px; border-radius: 50%; background: var(--af-border-strong); }
.provenance-entry-marker.tone-active { background: var(--af-cobalt); }
.provenance-entry-marker.tone-warning { background: var(--af-warning); }
.provenance-entry-marker.tone-success { background: var(--af-success); }
.provenance-entry-marker.tone-danger { background: var(--af-danger); }
.provenance-entry-copy { display: grid; min-width: 0; gap: 2px; }
.provenance-entry-copy strong { overflow-wrap: anywhere; color: var(--af-text); font-size: 0.6875rem; font-weight: 650; }
.provenance-entry-copy span { color: var(--af-text-muted); font-size: 0.625rem; }
</style>
