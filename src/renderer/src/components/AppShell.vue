<script setup lang="ts">
import { Boxes, ShieldCheck, Workflow } from '@lucide/vue'

defineProps<{
  version: string
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
        <button class="flex h-10 w-full items-center gap-3 rounded border border-forge-line bg-[#eef8f6] px-3 font-medium text-forge-mint">
          <Workflow :size="17" />
          自动化工作台
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

    <section class="flex min-w-0 flex-1 flex-col">
      <header class="flex h-16 shrink-0 items-center justify-between border-b border-forge-line bg-white px-5">
        <div>
          <h2 class="text-base font-semibold">自动化工具运行台</h2>
          <p class="text-xs text-slate-500">受控 SDK、插件权限、工作流状态机</p>
        </div>
        <div class="rounded border border-forge-line px-3 py-1.5 text-xs text-slate-600">
          Electron + Vite + Vue 3 + TypeScript
        </div>
      </header>

      <slot />
    </section>
  </div>
</template>
