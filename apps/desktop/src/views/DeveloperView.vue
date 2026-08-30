<template>
  <section class="developer-workbench">
    <div v-if="developer.loading && !developer.projects.length" class="developer-state">正在加载本地项目…</div>
    <div v-else-if="developer.error && !developer.projects.length" class="developer-state error" role="alert">{{ developer.error }}</div>
    <div v-else-if="!developer.projects.length" class="developer-state">
      <span class="af-panel-heading">开发工作台</span><h2>创建或导入本地工作流项目</h2><p>项目文件始终通过受控桌面 API 读取，不会向编辑器暴露本地文件系统。</p>
    </div>
    <CodeEditor v-else />
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import CodeEditor from '../components/developer/CodeEditor.vue'
import { useDeveloperStore } from '../stores/developer'

const developer = useDeveloperStore()
onMounted(() => { void developer.loadProjects() })
onBeforeUnmount(() => { void developer.flushPendingSaves() })
</script>

<style scoped>
.developer-workbench { height: 100%; min-height: 480px; background: var(--af-surface); }.developer-state { display: grid; min-height: 100%; place-content: center; gap: 7px; padding: 32px; color: var(--af-text-muted); text-align: center; }.developer-state h2 { margin: 0; color: var(--af-graphite); font-size: 1.1875rem; }.developer-state p { max-width: 500px; margin: 0; font-size: 0.8125rem; line-height: 1.6; }.developer-state.error { color: var(--af-danger); }
</style>
