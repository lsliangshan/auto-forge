<template>
  <details
    class="workflow-provenance"
    data-testid="workflow-provenance"
    :data-entry-count="block.entries.length"
  >
    <summary>
      已使用：{{ first.workflowName }} · {{ first.city ?? '不限城市' }}
      <span v-if="block.entries.length > 1">等 {{ block.entries.length }} 个</span>
    </summary>
    <div class="provenance-list">
      <div
        v-for="entry in block.entries"
        :key="entry.executionId"
        class="provenance-entry"
      >
        <div>
          <strong>{{ entry.workflowName }}</strong>
          <span>{{ entry.city ?? '不限城市' }} · {{ statusLabel(entry.status) }}</span>
        </div>
        <el-button
          size="small"
          :data-testid="`open-provenance-execution-${entry.executionId}`"
          @click="execution.select(entry.executionId)"
        >
          查看执行
        </el-button>
      </div>
    </div>
  </details>
</template>

<script setup lang="ts">
import type { ChatBlock, ExecutionStatus } from '@autoforge/shared'
import { computed } from 'vue'
import { useExecutionStore } from '../../stores/execution'

type WorkflowProvenanceBlock = Extract<ChatBlock, { type: 'workflow_provenance' }>
const props = defineProps<{ block: WorkflowProvenanceBlock }>()
const execution = useExecutionStore()
const first = computed(() => props.block.entries[0]!)

function statusLabel(status: ExecutionStatus): string {
  return ({
    queued: '排队中', awaiting_approval: '等待授权', running: '执行中', completed: '已完成',
    failed: '失败', cancelled: '已取消', interrupted: '已中断',
  })[status]
}
</script>

<style scoped>
.workflow-provenance { max-width: 640px; border: 1px solid var(--af-border); padding: 10px 12px; color: var(--af-text-muted); background: var(--af-surface-muted); font-size: 12px; }
summary { color: var(--af-text); cursor: pointer; font-weight: 600; } summary span { color: var(--af-text-muted); font-weight: 400; }
.provenance-list { display: grid; gap: 8px; margin-top: 10px; }
.provenance-entry { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px solid var(--af-border); padding-top: 8px; }
.provenance-entry > div { display: grid; min-width: 0; gap: 3px; }.provenance-entry strong { color: var(--af-text); overflow-wrap: anywhere; }.provenance-entry span { font-size: 11px; }
</style>
