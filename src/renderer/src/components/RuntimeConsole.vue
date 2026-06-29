<script setup lang="ts">
import { Terminal } from '@lucide/vue'
import type { WorkflowLog } from '@shared/workflow'

defineProps<{
  logs: WorkflowLog[]
}>()
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col rounded border border-forge-line bg-white">
    <div class="flex items-center gap-2 border-b border-forge-line px-5 py-3">
      <Terminal :size="17" class="text-slate-600" />
      <h3 class="text-sm font-semibold">运行日志</h3>
    </div>

    <div class="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs">
      <div v-if="logs.length === 0" class="text-slate-400">暂无日志</div>
      <div v-for="log in logs" :key="log.id" class="grid grid-cols-[74px_54px_minmax(0,1fr)] gap-3 border-b border-slate-100 py-2 last:border-b-0">
        <span class="text-slate-400">{{ log.time }}</span>
        <span
          class="uppercase"
          :class="{
            'text-forge-mint': log.level === 'info',
            'text-forge-amber': log.level === 'warn',
            'text-forge-rose': log.level === 'error'
          }"
        >
          {{ log.level }}
        </span>
        <span class="min-w-0 break-words text-slate-700">{{ log.message }}</span>
      </div>
    </div>
  </section>
</template>
