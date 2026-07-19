<template>
  <section class="execution-card">
    <div class="execution-topline">
      <div><span :class="['af-status-dot', statusTone]" /> <strong>工作流执行</strong></div>
      <span class="status-label">{{ statusLabel }}</span>
    </div>
    <code>{{ executionId }}</code>
    <p
      v-if="store.error"
      class="execution-error"
      role="alert"
    >
      {{ store.error }}
    </p>
    <div class="execution-actions">
      <el-button
        size="small"
        @click="store.select(executionId)"
      >
        在检查器中查看
      </el-button>
      <el-button
        v-if="cancellable"
        size="small"
        type="danger"
        plain
        @click="store.cancel(executionId)"
      >
        取消执行
      </el-button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useExecutionStore } from '../../stores/execution'

const props = defineProps<{ executionId: string }>()
const store = useExecutionStore()
onMounted(() => store.loadDetail(props.executionId))
const detail = computed(() => store.details[props.executionId])
const statusLabel = computed(() => ({
  queued: '排队中', awaiting_approval: '等待授权', running: '执行中', completed: '已完成',
  failed: '失败', cancelled: '已取消', interrupted: '已中断',
})[detail.value?.status ?? 'queued'])
const cancellable = computed(() => ['queued', 'awaiting_approval', 'running'].includes(detail.value?.status ?? 'queued'))
const statusTone = computed(() => detail.value?.status === 'completed' ? 'success' : detail.value?.status === 'failed' ? 'danger' : 'warning')
</script>

<style scoped>
.execution-card { max-width: 640px; border: 1px solid var(--af-border); border-left: 3px solid var(--af-cobalt); padding: 13px 14px; background: var(--af-surface-muted); }
.execution-topline, .execution-topline > div, .execution-actions { display: flex; align-items: center; }
.execution-topline { justify-content: space-between; }.execution-topline > div { gap: 8px; }
.status-label { color: var(--af-text-muted); font-size: 12px; }
code { display: block; margin-top: 8px; color: var(--af-text-muted); font-size: 11px; overflow-wrap: anywhere; }
.execution-actions { justify-content: flex-end; gap: 8px; margin-top: 10px; }
.execution-error { color: var(--af-danger); font-size: 12px; }
</style>
