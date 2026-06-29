<script setup lang="ts">
import { CheckCircle2, ShieldCheck } from '@lucide/vue'
import type { SecurityCapability } from '@shared/contracts'

defineProps<{
  items: SecurityCapability[]
}>()
</script>

<template>
  <section class="rounded border border-forge-line bg-white">
    <div class="flex items-center gap-2 border-b border-forge-line px-4 py-3">
      <ShieldCheck :size="17" class="text-forge-mint" />
      <h3 class="text-sm font-semibold">安全边界</h3>
    </div>

    <div class="divide-y divide-forge-line">
      <div v-for="item in items" :key="item.title" class="flex gap-3 px-4 py-3">
        <CheckCircle2 :size="17" class="mt-0.5 shrink-0 text-forge-mint" />
        <div>
          <div class="text-sm font-medium">{{ item.title }}</div>
          <p class="mt-1 text-xs leading-5 text-slate-500">{{ item.detail }}</p>
        </div>
      </div>
    </div>
  </section>
</template>
