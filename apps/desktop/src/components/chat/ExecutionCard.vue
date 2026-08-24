<template>
  <section :class="['execution-card', 'af-operation-card', `tone-${statusTone}`]">
    <header class="af-operation-card-header">
      <span
        :class="['af-operation-marker', `tone-${statusTone}`]"
        aria-hidden="true"
      >
        <el-icon :class="{ 'is-loading': detailLoading }">
          <component :is="statusIcon" />
        </el-icon>
      </span>
      <div class="af-operation-title">
        <span class="af-operation-eyebrow">执行记录</span>
        <strong>工作流执行</strong>
      </div>
      <div class="af-operation-summary">
        <span
          class="af-operation-badge"
          data-testid="execution-status-badge"
        >{{ statusLabel }}</span>
      </div>
    </header>
    <div class="af-operation-content">
      <div class="af-operation-meta">
        <code class="af-operation-chip">{{ executionId }}</code>
      </div>
      <p
        v-if="detailError"
        class="af-operation-alert execution-error"
        role="alert"
      >
        <el-icon aria-hidden="true">
          <Warning />
        </el-icon><span>{{ detailError }}</span>
      </p>
      <footer class="af-operation-footer">
        <button
          type="button"
          class="af-operation-link"
          @click="store.select(executionId)"
        >
          查看执行详情 <el-icon><ArrowRight /></el-icon>
        </button>
        <el-button
          v-if="cancellable"
          size="small"
          type="danger"
          plain
          @click="store.cancel(executionId)"
        >
          取消执行
        </el-button>
      </footer>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ArrowRight, Check, Clock, CloseBold, Loading, Warning } from '@element-plus/icons-vue'
import { computed, onMounted } from 'vue'
import { useExecutionStore } from '../../stores/execution'

const props = defineProps<{ executionId: string }>()
const store = useExecutionStore()
onMounted(() => store.loadDetail(props.executionId))
const detail = computed(() => store.details[props.executionId])
const detailError = computed(() => store.detailErrorsById[props.executionId] ?? '')
const detailLoading = computed(() => Boolean(store.detailLoadingById[props.executionId]))
const statusLabel = computed(() => ({
  queued: '排队中', awaiting_approval: '等待授权', running: '执行中', completed: '已完成',
  failed: '失败', cancelled: '已取消', interrupted: '已中断',
})[detail.value?.status ?? ''] ?? (detailLoading.value ? '正在加载' : detailError.value ? '加载失败' : '未知'))
const cancellable = computed(() => Boolean(detail.value && ['queued', 'awaiting_approval', 'running'].includes(detail.value.status)))
const statusTone = computed(() => {
  if (detailLoading.value) return 'active'
  if (!detail.value) return 'neutral'
  return ({
    queued: 'neutral', awaiting_approval: 'warning', running: 'active', completed: 'success',
    failed: 'danger', cancelled: 'neutral', interrupted: 'warning',
  })[detail.value.status]
})
const statusIcon = computed(() => {
  if (detailLoading.value) return Loading
  if (!detail.value) return detailError.value ? CloseBold : Clock
  return ({
    queued: Clock, awaiting_approval: Clock, running: Loading, completed: Check,
    failed: CloseBold, cancelled: CloseBold, interrupted: Warning,
  })[detail.value.status]
})
</script>

<style scoped>
.execution-error { color: var(--af-danger); }
</style>
