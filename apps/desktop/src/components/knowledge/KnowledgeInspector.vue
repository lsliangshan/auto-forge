<template>
  <section
    class="knowledge-inspector"
    data-testid="knowledge-inspector-pane"
    aria-label="知识详情"
  >
    <template v-if="store.selectedDocument">
      <header>
        <div>
          <span>文档详情</span>
          <strong>{{ store.selectedDocument.name }}</strong>
        </div>
        <span class="status">{{ store.selectedDocument.status }}</span>
      </header>
      <dl>
        <dt>类型</dt><dd>{{ store.selectedDocument.mimeType }}</dd>
        <dt>更新时间</dt><dd>{{ formatTime(store.selectedDocument.updatedAt) }}</dd>
      </dl>
      <div class="versions">
        <strong>版本</strong>
        <p
          v-for="version in store.versions"
          :key="version.id"
        >
          版本 {{ version.number }} · {{ version.status }}
        </p>
      </div>
      <footer>
        <button
          type="button"
          :disabled="store.busy"
          @click="store.replaceDocument"
        >
          替换文件
        </button>
        <button
          type="button"
          :disabled="store.busy"
          @click="store.runDocumentAction(store.selectedDocument.status === 'deleted' ? 'restore' : 'recycle')"
        >
          {{ store.selectedDocument.status === 'deleted' ? '恢复' : '移入回收站' }}
        </button>
        <button
          v-if="store.selectedDocument.status === 'deleted'"
          type="button"
          class="danger"
          :disabled="store.busy"
          @click="store.runDocumentAction('purge')"
        >
          永久删除
        </button>
      </footer>
    </template>
    <div
      v-else
      class="af-empty"
    >
      选择文档查看详情
    </div>
  </section>
</template>

<script setup lang="ts">
import { useKnowledgeStore } from '../../stores/knowledge'
const store = useKnowledgeStore()
const formatTime = (value: string) => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
</script>

<style scoped>
.knowledge-inspector { min-width: 0; overflow: auto; padding: 18px; background: var(--af-surface-muted); }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
header div { display: grid; gap: 5px; }
header span, dt { color: var(--af-text-muted); font-size: 11px; }
.status { border-radius: 999px; padding: 4px 7px; background: var(--af-cobalt-soft); }
dl { display: grid; grid-template-columns: 70px 1fr; gap: 9px; margin: 24px 0; }
dd { margin: 0; overflow-wrap: anywhere; font-size: 13px; }
.versions { border-top: 1px solid var(--af-border); padding-top: 16px; }
.versions p { color: var(--af-text-muted); font-size: 12px; }
footer { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
button { border: 1px solid var(--af-border-strong); border-radius: 7px; padding: 6px 9px; color: var(--af-text); background: var(--af-surface); cursor: pointer; }
.danger { color: var(--af-danger); }
</style>
