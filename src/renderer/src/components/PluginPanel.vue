<script setup lang="ts">
import { KeyRound, PackageCheck } from '@lucide/vue'
import type { ToolManifest } from '@shared/plugin'

defineProps<{
  plugins: ToolManifest[]
}>()
</script>

<template>
  <section class="rounded border border-forge-line bg-white">
    <div class="flex items-center gap-2 border-b border-forge-line px-4 py-3">
      <PackageCheck :size="17" class="text-forge-amber" />
      <h3 class="text-sm font-semibold">工具 Manifest</h3>
    </div>

    <div class="space-y-3 p-4">
      <article v-for="plugin in plugins" :key="plugin.name" class="rounded border border-forge-line p-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h4 class="truncate text-sm font-medium">{{ plugin.displayName ?? plugin.name }}</h4>
            <p class="mt-1 text-xs leading-5 text-slate-500">{{ plugin.description }}</p>
          </div>
          <span class="shrink-0 rounded bg-slate-100 px-2 py-1 text-[11px] text-slate-600">
            {{ plugin.version }}
          </span>
        </div>

        <div class="mt-3 flex flex-wrap gap-1.5">
          <span
            v-for="permission in plugin.permissions"
            :key="permission"
            class="inline-flex items-center gap-1 rounded border border-forge-line px-2 py-1 text-[11px] text-slate-600"
          >
            <KeyRound :size="12" />
            {{ permission }}
          </span>
        </div>
      </article>
    </div>
  </section>
</template>
