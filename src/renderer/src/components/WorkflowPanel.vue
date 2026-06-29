<script setup lang="ts">
import { computed } from 'vue'
import { Pause, Play, RotateCcw, StepForward } from '@lucide/vue'
import type { WorkflowSnapshot } from '@shared/workflow'

const props = defineProps<{
  snapshot: WorkflowSnapshot
}>()

const emit = defineEmits<{
  start: []
  pause: []
  resume: []
  reset: []
}>()

const primaryAction = computed(() => {
  switch (props.snapshot.status) {
    case 'running':
      return { label: '暂停', icon: Pause, event: 'pause' as const }
    case 'paused':
      return { label: '继续运行', icon: StepForward, event: 'resume' as const }
    case 'completed':
      return { label: '再次运行', icon: RotateCcw, event: 'start' as const }
    case 'error':
      return { label: '重试', icon: RotateCcw, event: 'start' as const }
    default:
      return { label: '运行', icon: Play, event: 'start' as const }
  }
})

function runPrimaryAction() {
  if (primaryAction.value.event === 'pause') {
    emit('pause')
    return
  }

  if (primaryAction.value.event === 'resume') {
    emit('resume')
    return
  }

  emit('start')
}
</script>

<template>
  <section class="rounded border border-forge-line bg-white shadow-panel">
    <div class="flex items-center justify-between border-b border-forge-line px-5 py-4">
      <div>
        <h3 class="text-sm font-semibold">工作流状态机</h3>
        <p class="text-xs text-slate-500">{{ snapshot.message }}</p>
      </div>
      <div class="flex items-center gap-2">
        <button
          class="inline-flex h-9 items-center gap-2 rounded bg-forge-mint px-3 text-sm font-medium text-white shadow-sm hover:bg-[#0b877a]"
          @click="runPrimaryAction"
        >
          <component :is="primaryAction.icon" :size="16" />
          {{ primaryAction.label }}
        </button>
        <button
          class="inline-flex h-9 items-center gap-2 rounded border border-forge-line px-3 text-sm text-slate-600 hover:bg-slate-50"
          @click="emit('reset')"
        >
          <RotateCcw :size="16" />
          重置
        </button>
      </div>
    </div>

    <div class="p-5">
      <div class="mb-5">
        <div class="mb-2 flex items-center justify-between text-xs text-slate-500">
          <span>运行进度</span>
          <span>{{ snapshot.progress }}%</span>
        </div>
        <div class="h-2 overflow-hidden rounded bg-slate-100">
          <div class="h-full rounded bg-forge-mint transition-all" :style="{ width: `${snapshot.progress}%` }" />
        </div>
      </div>

      <div class="grid grid-cols-5 gap-3">
        <div
          v-for="step in snapshot.steps"
          :key="step.id"
          class="rounded border px-3 py-3"
          :class="step.id === snapshot.activeStepId ? 'border-forge-mint bg-[#eef8f6]' : 'border-forge-line bg-white'"
        >
          <div class="text-xs font-medium text-slate-800">{{ step.label }}</div>
          <div class="mt-1 truncate text-[11px] text-slate-500">{{ step.capability }}</div>
        </div>
      </div>
    </div>
  </section>
</template>
