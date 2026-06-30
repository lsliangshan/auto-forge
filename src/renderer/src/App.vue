<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { AppView } from '@shared/contracts'
import { usePlatformStore } from '@renderer/stores/platform'
import AppShell from '@renderer/components/AppShell.vue'
import AutomationTasksPage from '@renderer/components/AutomationTasksPage.vue'
import BrowserWindowShell from '@renderer/components/BrowserWindowShell.vue'
import PluginPanel from '@renderer/components/PluginPanel.vue'
import RuntimeConsole from '@renderer/components/RuntimeConsole.vue'
import SecurityPanel from '@renderer/components/SecurityPanel.vue'
import WorkflowPanel from '@renderer/components/WorkflowPanel.vue'

const store = usePlatformStore()
const activeView = ref<AppView>('workbench')
const isBrowserWindow = window.location.hash === '#/browser'

const appVersion = computed(() => {
  return store.overview ? `v${store.overview.app.version}` : 'v0.1.0'
})

let unsubscribe: (() => void) | null = null

onMounted(async () => {
  if (isBrowserWindow) {
    return
  }

  await store.bootstrap()
  unsubscribe = window.autoForge.workflow.onChanged((snapshot) => {
    store.setWorkflow(snapshot)
  })
})

onUnmounted(() => {
  unsubscribe?.()
})

async function openBrowserWindow() {
  await window.autoForge.browser.openWindow()
}
</script>

<template>
  <BrowserWindowShell v-if="isBrowserWindow" />

  <AppShell
    v-else
    :active-view="activeView"
    :version="appVersion"
    @open-browser="openBrowserWindow"
    @select-view="activeView = $event"
  >
    <template v-if="store.workflow && store.overview && activeView === 'workbench'">
      <main class="grid min-h-0 flex-1 grid-cols-[minmax(0,1.35fr)_420px] gap-4 p-4">
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

    <AutomationTasksPage v-else-if="activeView === 'automationTasks'" />

    <div v-else class="grid h-full place-items-center text-sm text-slate-500">
      正在加载 AutoForge 工作台
    </div>
  </AppShell>
</template>
