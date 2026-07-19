<template>
  <div class="workbench">
    <AppRail />
    <ContextSidebar />
    <main
      class="workspace"
      tabindex="-1"
    >
      <header class="workspace-header">
        <div>
          <span class="workspace-eyebrow">AutoForge</span>
          <h1>{{ route.meta.title }}</h1>
        </div>
        <el-button
          v-if="route.meta.inspector"
          data-testid="inspector-toggle"
          class="inspector-toggle"
          :aria-label="inspectorOpen ? '关闭检查器' : '打开检查器'"
          :aria-expanded="inspectorOpen"
          @click="inspectorOpen = !inspectorOpen"
        >
          <el-icon><Operation /></el-icon>
          {{ inspectorOpen ? '隐藏检查器' : '查看检查器' }}
        </el-button>
      </header>
      <div class="workspace-content af-scrollbar">
        <RouterView />
      </div>
    </main>
    <InspectorPanel
      v-if="route.meta.inspector"
      :open="inspectorOpen"
      @close="inspectorOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { Operation } from '@element-plus/icons-vue'
import { ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import AppRail from '../components/AppRail.vue'
import ContextSidebar from '../components/ContextSidebar.vue'
import InspectorPanel from '../components/InspectorPanel.vue'

const route = useRoute()
const inspectorOpen = ref(typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1180px)').matches)
watch(() => route.name, () => {
  inspectorOpen.value = typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1180px)').matches
})
</script>

<style scoped>
.workbench { display: flex; width: 100%; height: 100%; overflow: hidden; background: var(--af-canvas); }
.workspace { display: flex; min-width: 0; flex: 1; flex-direction: column; }
.workspace-header { display: flex; min-height: 58px; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--af-border); padding: 8px 18px; background: var(--af-surface); -webkit-app-region: drag; }
.workspace-header h1 { margin: 0; color: var(--af-graphite); font-size: 18px; font-weight: 680; }
.workspace-eyebrow { display: block; margin-bottom: 1px; color: var(--af-text-muted); font-size: 10px; letter-spacing: .12em; text-transform: uppercase; }
.inspector-toggle { -webkit-app-region: no-drag; }
.workspace-content { min-height: 0; flex: 1; overflow: auto; }
</style>
