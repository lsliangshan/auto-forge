<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { usePlatformStore } from '@renderer/stores/platform'
import AppShell from '@renderer/components/AppShell.vue'
import PluginPanel from '@renderer/components/PluginPanel.vue'
import RuntimeConsole from '@renderer/components/RuntimeConsole.vue'
import SecurityPanel from '@renderer/components/SecurityPanel.vue'
import WorkflowPanel from '@renderer/components/WorkflowPanel.vue'

const store = usePlatformStore()

const appVersion = computed(() => {
  return store.overview ? `v${store.overview.app.version}` : 'v0.1.0'
})

let unsubscribe: (() => void) | null = null

onMounted(async () => {
  await store.bootstrap()
  unsubscribe = window.autoForge.workflow.onChanged((snapshot) => {
    store.setWorkflow(snapshot)
  })
})

onUnmounted(() => {
  unsubscribe?.()
})
</script>

<template>
  <AppShell :version="appVersion">
    <template v-if="store.workflow && store.overview">
      <main class="grid min-h-0 grid-cols-[minmax(0,1.35fr)_420px] gap-4 p-4">
        <section class="flex min-h-0 flex-col gap-4">
          <WorkflowPanel
            :snapshot="store.workflow"
            @start="store.startWorkflow"
            @pause="store.pauseWorkflow"
            @resume="store.resumeWorkflow"
            @reset="store.resetWorkflow"
          />
          <RuntimeConsole :logs="store.workflow.logs" />
        </section>

        <aside class="flex min-h-0 flex-col gap-4">
          <PluginPanel :plugins="store.plugins" />
          <SecurityPanel :items="store.overview.security" />
        </aside>
      </main>
    </template>

    <div v-else class="grid h-full place-items-center text-sm text-slate-500">
      正在加载 AutoForge 工作台
    </div>
  </AppShell>
</template>
