<script setup lang="ts">
import { Boxes, Globe2, ListChecks, ShieldCheck, Workflow } from '@lucide/vue'
import type { AppView } from '@shared/contracts'

defineProps<{
  activeView: AppView
  version: string
}>()

const emit = defineEmits<{
  openBrowser: []
  selectView: [view: AppView]
}>()
</script>

<template>
  <div class="flex h-screen overflow-hidden bg-[#f5f7fa] text-forge-ink">
    <aside class="flex w-64 shrink-0 flex-col border-r border-forge-line bg-white">
      <div class="flex h-16 items-center gap-3 border-b border-forge-line px-5">
        <div class="grid h-9 w-9 place-items-center rounded bg-forge-mint text-white">
          <Boxes :size="20" />
        </div>
        <div class="min-w-0">
          <h1 class="truncate text-base font-semibold">AutoForge</h1>
          <p class="text-xs text-slate-500">Build Once, Automate Everywhere</p>
        </div>
      </div>

      <nav class="flex-1 space-y-1 px-3 py-4 text-sm">
        <button
          class="flex h-10 w-full items-center gap-3 rounded px-3"
          :class="activeView === 'workbench' ? 'border border-forge-line bg-[#eef8f6] font-medium text-forge-mint' : 'text-slate-600'"
          @click="emit('selectView', 'workbench')"
        >
          <Workflow :size="17" />
          自动化工作台
        </button>
        <button
          class="flex h-10 w-full items-center gap-3 rounded px-3 text-slate-600"
          @click="emit('openBrowser')"
        >
          <Globe2 :size="17" />
          浏览器
        </button>
        <button
          class="flex h-10 w-full items-center gap-3 rounded px-3"
          :class="activeView === 'automationTasks' ? 'border border-forge-line bg-[#eef8f6] font-medium text-forge-mint' : 'text-slate-600'"
          @click="emit('selectView', 'automationTasks')"
        >
          <ListChecks :size="17" />
          自动化任务
        </button>
        <button class="flex h-10 w-full items-center gap-3 rounded px-3 text-slate-600">
          <ShieldCheck :size="17" />
          权限与沙箱
        </button>
      </nav>

      <footer class="border-t border-forge-line px-5 py-4 text-xs text-slate-500">
        <div>Desktop Platform</div>
        <div>{{ version }}</div>
      </footer>
    </aside>

    <section class="flex min-h-0 min-w-0 flex-1 flex-col">
      <slot />
    </section>
  </div>
</template>
