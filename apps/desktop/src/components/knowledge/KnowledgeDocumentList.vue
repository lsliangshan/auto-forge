<template>
  <section
    class="knowledge-pane"
    data-testid="knowledge-document-pane"
    aria-label="文档列表"
  >
    <header>
      <strong>文档</strong>
      <button
        type="button"
        :disabled="!store.selectedBaseId || store.busy"
        @click="store.importDocuments"
      >
        导入
      </button>
    </header>
    <div class="knowledge-list af-scrollbar">
      <button
        v-for="document in store.documents"
        :key="document.id"
        type="button"
        class="knowledge-list-item"
        :class="{ selected: document.id === store.selectedDocumentId }"
        :data-testid="`knowledge-document-${document.id}`"
        @click="store.selectDocument(document.id)"
      >
        <span class="af-truncate">{{ document.name }}</span>
        <small>{{ statusLabel(document.status) }}</small>
      </button>
      <p
        v-if="store.selectedBaseId && !store.documents.length && !store.loading"
        class="knowledge-empty"
      >
        暂无文档
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { KnowledgeDocumentSummary } from '@autoforge/shared'
import { useKnowledgeStore } from '../../stores/knowledge'

const store = useKnowledgeStore()
const labels: Record<KnowledgeDocumentSummary['status'], string> = {
  queued: '等待处理', copying: '正在复制', parsing: '正在解析', indexing: '正在索引',
  ready: '可检索', failed: '处理失败', paused: '已暂停', deleted: '回收站',
}
const statusLabel = (status: KnowledgeDocumentSummary['status']) => labels[status]
</script>

<style scoped>
.knowledge-pane { display: flex; min-width: 0; flex-direction: column; border-right: 1px solid var(--af-border); background: var(--af-surface); }
header { display: flex; min-height: 48px; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--af-border); }
button { border: 1px solid var(--af-border); border-radius: 7px; padding: 5px 8px; color: var(--af-text); background: var(--af-surface); cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .55; }
.knowledge-list { min-height: 0; flex: 1; overflow: auto; padding: 8px; }
.knowledge-list-item { display: grid; width: 100%; gap: 4px; margin-bottom: 5px; padding: 10px; text-align: left; }
.knowledge-list-item.selected { border-color: var(--af-cobalt); background: var(--af-cobalt-soft); }
small, .knowledge-empty { color: var(--af-text-muted); }
.knowledge-empty { padding: 14px; font-size: 12px; text-align: center; }
</style>
