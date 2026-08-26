<template>
  <section
    class="knowledge-view"
    aria-label="知识库文件"
    :aria-busy="knowledge.loading || knowledge.documentsLoading"
  >
    <header class="knowledge-toolbar">
      <div>
        <span class="af-panel-heading">文件</span>
        <strong>{{ knowledge.selectedBase?.name ?? '未选择知识库' }}</strong>
      </div>
      <div class="toolbar-actions">
        <div
          v-if="knowledge.selectedBase?.kind === 'cloud'"
          class="embedding-consent-controls"
        >
          <small>混合检索会将片段和查询发送至 TokenHub（广州）处理</small>
          <span>
            <el-button
              v-if="knowledge.consent?.embedding.status === 'unknown'"
              data-testid="knowledge-embedding-deny"
              size="small"
              :disabled="knowledge.operationPending"
              @click="knowledge.setEmbeddingConsent('denied')"
            >不同意</el-button>
            <el-button
              v-if="knowledge.consent?.embedding.status !== 'granted'"
              data-testid="knowledge-embedding-grant"
              size="small"
              :disabled="knowledge.operationPending || !knowledge.availability?.cloud.available"
              @click="knowledge.setEmbeddingConsent('granted')"
            >同意并启用</el-button>
            <el-button
              v-else
              data-testid="knowledge-embedding-revoke"
              size="small"
              :disabled="knowledge.operationPending"
              @click="knowledge.setEmbeddingConsent('revoked')"
            >撤回授权</el-button>
          </span>
        </div>
        <el-button
          data-testid="knowledge-import"
          type="primary"
          :disabled="!knowledge.canImport || knowledge.operationPending"
          @click="knowledge.importDocument"
        >导入文件</el-button>
        <el-button
          data-testid="knowledge-export"
          :disabled="!knowledge.canExport || knowledge.operationPending"
          @click="knowledge.exportSelectedBase"
        >导出</el-button>
      </div>
    </header>

    <div
      v-if="knowledge.entitlement?.killSwitchEnabled"
      class="downgrade-state"
      role="status"
    >
      <span>云端功能和新的 Agent 知识工具已暂停；本地管理、导出和删除仍可用。</span>
    </div>

    <div
      v-if="knowledge.entitlement?.lifecycle?.requiresSelection"
      class="downgrade-state"
      role="status"
    >
      <span>
        会员已到期，请选择一个本地文件继续使用；其他内容将保持加密只读。
        <small>{{ lifecycleMessage }}</small>
      </span>
      <el-button
        data-testid="knowledge-keep-document"
        size="small"
        type="primary"
        :disabled="!knowledge.selectedDocument || knowledge.operationPending"
        @click="knowledge.chooseDowngradeSelection"
      >保留当前文件</el-button>
    </div>

    <div v-if="knowledge.error" class="knowledge-state error" role="alert">
      {{ knowledge.error }}
    </div>
    <div v-else-if="knowledge.loading || knowledge.documentsLoading" class="knowledge-state" aria-live="polite">
      正在加载知识库…
    </div>
    <div v-else-if="!knowledge.selectedBaseId" class="knowledge-state">
      先在左侧创建或选择知识库。
    </div>
    <div v-else-if="!knowledge.documents.length" class="knowledge-state">
      <p>还没有文件</p>
      <small>支持文本型 PDF、DOCX、UTF-8 TXT、Markdown 和 HTML。</small>
    </div>
    <div v-else class="document-list af-scrollbar" role="listbox" aria-label="文件列表">
      <button
        v-for="document in knowledge.documents"
        :key="document.id"
        type="button"
        role="option"
        :aria-selected="knowledge.selectedDocumentId === document.id"
        :data-testid="`knowledge-document-${document.id}`"
        :class="['document-row', { selected: knowledge.selectedDocumentId === document.id }]"
        @click="knowledge.selectDocument(document.id)"
      >
        <span class="document-icon"><el-icon><Document /></el-icon></span>
        <span class="document-main">
          <strong>{{ document.name }}</strong>
          <small>{{ document.mimeType }} · {{ document.versionCount }} 个版本</small>
        </span>
        <span :class="['status-badge', statusTone(document.status)]">{{ statusLabel(document.status) }}</span>
        <time :datetime="document.updatedAt">{{ new Date(document.updatedAt).toLocaleString('zh-CN') }}</time>
      </button>
    </div>

    <div v-if="knowledge.operationError || knowledge.pollingError" class="operation-error" role="alert">
      <span>{{ knowledge.operationError || knowledge.pollingError }}</span>
      <el-button size="small" @click="knowledge.operationError = ''; knowledge.pollingError = ''">关闭</el-button>
    </div>

    <footer v-if="knowledge.selectedDocument" class="document-actions">
      <span>只有已就绪的发布版本可被检索。</span>
      <div>
        <el-button
          data-testid="knowledge-replace"
          :disabled="!knowledge.canReplace || knowledge.operationPending"
          @click="knowledge.replaceSelectedDocument"
        >替换文件</el-button>
        <el-button
          data-testid="knowledge-recycle-document"
          type="danger"
          plain
          :disabled="!knowledge.canRecycle || knowledge.operationPending"
          @click="recycleDocument"
        >移入回收站</el-button>
      </div>
    </footer>
  </section>
</template>

<script setup lang="ts">
import type { KnowledgeDocument } from '@autoforge/shared'
import { Document } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useKnowledgeStore } from '../stores/knowledge'

const knowledge = useKnowledgeStore()
let mounted = true
const lifecycleMessage = computed(() => {
  const lifecycle = knowledge.entitlement?.lifecycle
  if (!lifecycle) return ''
  if (lifecycle.phase === 'download_window') {
    return `云端内容可下载或转换至 ${new Date(lifecycle.downloadUntil).toLocaleDateString('zh-CN')}`
  }
  if (lifecycle.phase === 'recycle_window') return '云端内容处于回收期，可继续管理本地缓存'
  if (lifecycle.phase === 'purge_eligible') return '云端内容已具备清理资格'
  return ''
})
const statusLabels: Record<KnowledgeDocument['status'], string> = {
  queued: '排队中', copying: '复制中', uploading: '上传中', parsing: '解析中',
  indexing: '索引中', ready: '已就绪', failed: '处理失败', paused: '已暂停', deleted: '已删除',
}
const statusLabel = (status: KnowledgeDocument['status']) => statusLabels[status]
const statusTone = (status: KnowledgeDocument['status']) =>
  status === 'ready' ? 'success' : status === 'failed' || status === 'deleted' ? 'danger' : 'warning'

async function recycleDocument() {
  const document = knowledge.selectedDocument
  if (!document) return
  try {
    await ElMessageBox.confirm(`确认将“${document.name}”移入回收站？`, '回收文件', {
      type: 'warning', confirmButtonText: '确认回收', cancelButtonText: '取消',
    })
    await knowledge.recycleSelectedDocument()
  } catch { /* Cancellation does not mutate knowledge state. */ }
}

onMounted(async () => {
  await knowledge.load()
  if (mounted) knowledge.startProcessingPolling()
})
onBeforeUnmount(() => {
  mounted = false
  knowledge.stopProcessingPolling()
})
</script>

<style scoped>
.knowledge-view { display: flex; min-height: 100%; flex-direction: column; }
.knowledge-toolbar { display: flex; min-height: 66px; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--af-border); padding: 12px 18px; background: var(--af-surface); }
.knowledge-toolbar > div:first-child { display: grid; gap: 3px; }.knowledge-toolbar strong { font-size: 14px; }.toolbar-actions { display: flex; align-items: center; gap: 8px; }.embedding-consent-controls { display: grid; max-width: 290px; gap: 3px; color: var(--af-text-muted); font-size: 10px; text-align: right; }.embedding-consent-controls > span { display: flex; justify-content: flex-end; gap: 4px; }
.downgrade-state { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--af-warning); padding: 9px 18px; color: var(--af-warning); background: rgb(216 144 24 / 8%); font-size: 12px; }
.downgrade-state > span { display: grid; gap: 2px; }.downgrade-state small { color: var(--af-text-muted); }
.knowledge-state { display: grid; min-height: 240px; flex: 1; place-content: center; color: var(--af-text-muted); text-align: center; }.knowledge-state p { margin: 0 0 6px; color: var(--af-text); }.knowledge-state.error { color: var(--af-danger); }
.document-list { min-height: 0; flex: 1; padding: 12px 18px; overflow: auto; }
.document-row { display: grid; width: 100%; grid-template-columns: 34px minmax(0, 1fr) auto 150px; align-items: center; gap: 10px; border: 1px solid transparent; border-bottom-color: var(--af-border); padding: 12px 10px; color: var(--af-text); background: transparent; cursor: pointer; text-align: left; }
.document-row:hover { background: var(--af-hover); }.document-row.selected { border-color: var(--af-cobalt); border-radius: 7px; background: var(--af-cobalt-soft); }
.document-icon { display: grid; width: 30px; height: 30px; place-items: center; border-radius: 6px; color: var(--af-cobalt); background: var(--af-surface-muted); }.document-main { display: grid; min-width: 0; gap: 3px; }.document-main strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.document-main small, .document-row time { color: var(--af-text-muted); font-size: 11px; }
.status-badge { border-radius: 999px; padding: 3px 7px; font-size: 11px; }.status-badge.success { color: var(--af-success); background: rgb(36 158 98 / 10%); }.status-badge.warning { color: var(--af-warning); background: rgb(216 144 24 / 10%); }.status-badge.danger { color: var(--af-danger); background: rgb(180 35 24 / 10%); }
.operation-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px solid var(--af-danger); padding: 9px 18px; color: var(--af-danger); background: rgb(180 35 24 / 6%); font-size: 12px; }
.document-actions { display: flex; min-height: 62px; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px solid var(--af-border); padding: 10px 18px; background: var(--af-surface); }.document-actions > span { color: var(--af-text-muted); font-size: 11px; }.document-actions > div { display: flex; gap: 8px; }
@media (max-width: 920px) { .document-row { grid-template-columns: 30px minmax(0, 1fr) auto; }.document-row time { display: none; }.document-actions { align-items: flex-start; flex-direction: column; } }
</style>
