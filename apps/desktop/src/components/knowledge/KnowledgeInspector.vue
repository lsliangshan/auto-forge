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
        <span class="status">{{ statusLabel(store.selectedDocument.status) }}</span>
      </header>
      <dl>
        <dt>类型</dt><dd>{{ store.selectedDocument.mimeType }}</dd>
        <dt>更新时间</dt><dd>{{ formatTime(store.selectedDocument.updatedAt) }}</dd>
      </dl>
      <p
        v-if="store.selectedDocument.status === 'failed'"
        class="failure"
        role="status"
      >
        处理失败，可重新导入或替换文件。原有可用版本不会被替换。
      </p>
      <div class="versions">
        <strong>版本</strong>
        <p
          v-for="version in store.versions"
          :key="version.id"
        >
          版本 {{ version.number }} · {{ versionStatusLabel(version.status) }}
        </p>
      </div>
      <footer>
        <button
          type="button"
          data-testid="knowledge-replace"
          :disabled="store.busy || !store.localAvailable"
          @click="store.replaceDocument"
        >
          替换文件
        </button>
        <button
          type="button"
          :disabled="store.busy || !store.localAvailable"
          @click="store.runDocumentAction(store.selectedDocument.status === 'deleted' ? 'restore' : 'recycle')"
        >
          {{ store.selectedDocument.status === 'deleted' ? '恢复' : '移入回收站' }}
        </button>
        <button
          v-if="store.selectedDocument.status === 'deleted'"
          type="button"
          class="danger"
          data-testid="knowledge-purge-document"
          :aria-label="`永久删除文档 ${store.selectedDocument.name}`"
          :disabled="store.busy || purgePending || !store.localAvailable"
          @click="purgeDocument"
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
import type { KnowledgeDocumentSummary, KnowledgeVersionSummary } from '@autoforge/shared'
import { ElMessageBox } from 'element-plus'
import { ref } from 'vue'
import { useKnowledgeStore } from '../../stores/knowledge'
const store = useKnowledgeStore()
const purgePending = ref(false)
const labels: Record<KnowledgeDocumentSummary['status'], string> = {
  queued: '等待处理', copying: '正在复制', parsing: '正在解析', indexing: '正在索引',
  ready: '可检索', failed: '处理失败', paused: '已暂停', deleted: '回收站',
}
const statusLabel = (status: KnowledgeDocumentSummary['status']) => labels[status]
const versionLabels: Record<KnowledgeVersionSummary['status'], string> = {
  staging: '处理中', ready: '可检索', failed: '处理失败', retired: '历史版本',
}
const versionStatusLabel = (status: KnowledgeVersionSummary['status']) => versionLabels[status]
const formatTime = (value: string) => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
async function purgeDocument() {
  const selected = store.selectedDocument
  if (!selected || selected.status !== 'deleted' || purgePending.value) return
  const ownerToken = store.captureOwnerToken()
  if (!ownerToken) return
  const documentId = selected.id
  purgePending.value = true
  try {
    await ElMessageBox.confirm(
      `永久删除“${selected.name}”及其全部版本？此操作无法撤销。`,
      '永久删除文档',
      { type: 'warning', confirmButtonText: '永久删除', cancelButtonText: '取消' },
    )
    if (!store.isOwnerTokenCurrent(ownerToken) || store.selectedDocumentId !== documentId) return
    await store.runDocumentAction('purge')
  } catch {
    // Cancellation is an expected terminal result.
  } finally {
    purgePending.value = false
  }
}
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
.failure { border: 1px solid var(--af-border); border-radius: 8px; padding: 9px 10px; color: var(--af-danger); background: var(--af-surface); font-size: 12px; }
footer { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
button { border: 1px solid var(--af-border-strong); border-radius: 7px; padding: 6px 9px; color: var(--af-text); background: var(--af-surface); cursor: pointer; }
.danger { color: var(--af-danger); }
</style>
