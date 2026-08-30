<template>
  <section
    class="knowledge-workbench"
    data-testid="knowledge-inspector-pane"
    aria-label="文档工作台"
  >
    <template v-if="store.selectedDocument">
      <header class="workbench-toolbar">
        <div class="document-identity">
          <span
            class="document-icon"
            :class="fileTone(store.selectedDocument.mimeType)"
          >
            {{ fileExtension(store.selectedDocument.name) }}
          </span>
          <div>
            <span class="eyebrow">{{ store.selectedBase?.name }} / 文档</span>
            <strong>{{ store.selectedDocument.name }}</strong>
            <small
              class="status"
              :class="statusTone(store.selectedDocument.status)"
            >
              <i />{{ statusLabel(store.selectedDocument.status) }}
            </small>
          </div>
        </div>
        <div class="document-actions">
          <button
            type="button"
            class="primary-action"
            data-testid="knowledge-replace"
            :disabled="store.busy || !store.localAvailable || store.selectedDocument.readOnly === true"
            @click="store.replaceDocument"
          >
            <el-icon><Refresh /></el-icon>
            替换文件
          </button>
          <button
            type="button"
            :class="{ danger: store.selectedDocument.status !== 'deleted' }"
            :disabled="store.busy || !store.localAvailable || (store.selectedDocument.status === 'deleted' && store.selectedDocument.readOnly === true)"
            @click="store.runDocumentAction(store.selectedDocument.status === 'deleted' ? 'restore' : 'recycle')"
          >
            <el-icon><RefreshLeft v-if="store.selectedDocument.status === 'deleted'" /><Delete v-else /></el-icon>
            {{ store.selectedDocument.status === 'deleted' ? '恢复文件' : '移入回收站' }}
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
        </div>
      </header>

      <nav
        class="workbench-tabs"
        aria-label="文档视图"
      >
        <button
          type="button"
          data-testid="knowledge-tab-preview"
          :class="{ active: activeTab === 'preview' }"
          :aria-current="activeTab === 'preview' ? 'page' : undefined"
          @click="activeTab = 'preview'"
        >
          <el-icon><View /></el-icon>预览
        </button>
        <button
          type="button"
          data-testid="knowledge-tab-info"
          :class="{ active: activeTab === 'info' }"
          :aria-current="activeTab === 'info' ? 'page' : undefined"
          @click="activeTab = 'info'"
        >
          <el-icon><InfoFilled /></el-icon>文件信息
        </button>
        <button
          type="button"
          data-testid="knowledge-tab-versions"
          :class="{ active: activeTab === 'versions' }"
          :aria-current="activeTab === 'versions' ? 'page' : undefined"
          @click="activeTab = 'versions'"
        >
          <el-icon><Clock /></el-icon>版本记录
          <small>{{ store.versions.length }}</small>
        </button>
      </nav>

      <div
        class="workbench-content af-scrollbar"
        data-testid="knowledge-workbench"
      >
        <section
          v-if="activeTab === 'preview'"
          class="preview-panel"
          :class="{ 'original-preview-panel': store.documentPreview?.kind === 'original' }"
        >
          <div
            v-if="store.previewLoading"
            class="workbench-empty compact"
          >
            <span class="empty-icon"><el-icon class="spin"><Loading /></el-icon></span>
            <strong>正在准备预览</strong>
            <p>正在从本地加密存储中读取原始文件。</p>
          </div>
          <KnowledgeOriginalPreview
            v-else-if="store.documentPreview?.kind === 'original'"
            :preview="store.documentPreview"
          />
          <article
            v-else-if="store.documentPreview?.kind === 'available'"
            class="preview-sheet"
            :class="fileTone(store.selectedDocument.mimeType)"
            data-testid="knowledge-preview-content"
          >
            <header>
              <span>{{ friendlyType(store.selectedDocument.mimeType) }}</span>
              <small>解析文本预览</small>
            </header>
            <pre>{{ store.documentPreview.content }}</pre>
            <footer v-if="store.documentPreview.truncated">
              内容较长，这里仅显示前 20,000 个字符。
            </footer>
          </article>
          <div
            v-else
            class="workbench-empty"
          >
            <span class="empty-icon"><el-icon><Document /></el-icon></span>
            <strong>{{ previewUnavailableTitle }}</strong>
            <p>{{ previewUnavailableDescription }}</p>
            <button
              v-if="store.selectedDocument.status === 'failed'"
              type="button"
              :disabled="store.busy || !store.localAvailable || store.selectedDocument.readOnly === true"
              @click="store.replaceDocument"
            >
              重新选择文件
            </button>
          </div>
        </section>

        <section
          v-else-if="activeTab === 'info'"
          class="information-panel"
        >
          <div class="detail-card">
            <header><span>信息</span><strong>文件信息</strong></header>
            <dl>
              <div><dt>文件类型</dt><dd>{{ friendlyType(store.selectedDocument.mimeType) }}</dd></div>
              <div>
                <dt>MIME</dt><dd class="technical-value">
                  {{ store.selectedDocument.mimeType }}
                </dd>
              </div>
              <div><dt>所属知识库</dt><dd>{{ store.selectedBase?.name }}</dd></div>
              <div><dt>更新时间</dt><dd>{{ formatTime(store.selectedDocument.updatedAt) }}</dd></div>
              <div><dt>检索状态</dt><dd>{{ statusDescription(store.selectedDocument.status) }}</dd></div>
            </dl>
          </div>
          <p
            v-if="store.selectedDocument.status === 'failed'"
            class="failure"
            role="status"
          >
            <el-icon><WarningFilled /></el-icon>
            <span><strong>文档处理失败</strong>处理失败，可重新导入或替换文件。原有可用版本不会被替换。</span>
          </p>
        </section>

        <section
          v-else
          class="versions-panel"
        >
          <header class="section-heading">
            <div><span>记录</span><strong>版本历史</strong></div>
            <small>{{ store.versions.length }} 个版本</small>
          </header>
          <div
            v-if="store.versions.length"
            class="version-list"
          >
            <article
              v-for="version in store.versions"
              :key="version.id"
            >
              <span
                class="version-marker"
                :class="versionTone(version.status)"
              ><i /></span>
              <div>
                <strong>版本 {{ version.number }} · {{ versionStatusLabel(version.status) }}</strong>
                <small>{{ formatTime(version.createdAt) }}</small>
              </div>
              <span
                v-if="version.status === 'ready'"
                class="current-version"
              >当前可用</span>
            </article>
          </div>
          <div
            v-else
            class="workbench-empty compact"
          >
            <strong>暂无版本信息</strong>
          </div>
        </section>
      </div>

      <footer class="workbench-statusbar">
        <span>{{ fileExtension(store.selectedDocument.name) }} · {{ friendlyType(store.selectedDocument.mimeType) }}</span>
        <span>{{ store.versions.length }} 个版本 · {{ statusLabel(store.selectedDocument.status) }}</span>
      </footer>
    </template>

    <div
      v-else
      class="workbench-empty fill"
    >
      <span class="empty-icon"><el-icon><Reading /></el-icon></span>
      <strong>从左侧选择一个文档</strong>
      <p>选中后可以预览内容、查看文件信息和版本记录。</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { KnowledgeDocumentSummary, KnowledgeVersionSummary } from '@autoforge/shared'
import {
  Clock,
  Delete,
  Document,
  InfoFilled,
  Loading,
  Reading,
  Refresh,
  RefreshLeft,
  View,
  WarningFilled,
} from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import { computed, ref, watch } from 'vue'
import { useKnowledgeStore } from '../../stores/knowledge'
import KnowledgeOriginalPreview from './KnowledgeOriginalPreview.vue'

type WorkbenchTab = 'preview' | 'info' | 'versions'

const store = useKnowledgeStore()
const activeTab = ref<WorkbenchTab>('preview')
const purgePending = ref(false)
const labels: Record<KnowledgeDocumentSummary['status'], string> = {
  queued: '等待处理', copying: '正在复制', parsing: '正在解析', indexing: '正在索引',
  ready: '可检索', failed: '处理失败', paused: '已暂停', deleted: '回收站',
}
const descriptions: Record<KnowledgeDocumentSummary['status'], string> = {
  queued: '已加入处理队列', copying: '正在安全复制文件', parsing: '正在解析文档内容', indexing: '正在建立检索索引',
  ready: '已完成索引，可在聊天中使用', failed: '处理失败，请替换文件后重试', paused: '处理已暂停', deleted: '文件位于回收站',
}
const versionLabels: Record<KnowledgeVersionSummary['status'], string> = {
  staging: '处理中', ready: '可检索', failed: '处理失败', retired: '历史版本',
}

watch(() => store.selectedDocumentId, () => { activeTab.value = 'preview' })

const statusLabel = (status: KnowledgeDocumentSummary['status']) => labels[status]
const statusDescription = (status: KnowledgeDocumentSummary['status']) => descriptions[status]
const statusTone = (status: KnowledgeDocumentSummary['status']) => ({
  queued: 'active', copying: 'active', parsing: 'active', indexing: 'active', ready: 'success',
  failed: 'danger', paused: 'warning', deleted: 'neutral',
})[status]
const versionStatusLabel = (status: KnowledgeVersionSummary['status']) => versionLabels[status]
const versionTone = (status: KnowledgeVersionSummary['status']) => ({
  staging: 'active', ready: 'success', failed: 'danger', retired: 'neutral',
})[status]
const formatTime = (value: string) => new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(value))

const previewUnavailableTitle = computed(() => {
  if (store.selectedDocument?.status === 'failed') return '文档处理失败'
  if (store.selectedDocument?.status === 'deleted') return '回收站文件不提供预览'
  if (store.selectedDocument?.status !== 'ready') return '内容正在准备中'
  return '暂时无法预览此文档'
})
const previewUnavailableDescription = computed(() => {
  if (store.selectedDocument?.status === 'failed') return '处理失败，可重新导入或替换文件。原有可用版本不会被替换。'
  if (store.selectedDocument?.status === 'deleted') return '恢复文件后即可重新查看内容。'
  if (store.selectedDocument?.status !== 'ready') return '解析与索引完成后，预览内容会自动出现。'
  return '文档没有可用的原始文件或解析文本，你仍然可以查看文件信息和版本记录。'
})

function fileExtension(value: string): string {
  const extension = value.split('.').pop()?.toUpperCase()
  return extension && extension.length <= 5 ? extension : 'FILE'
}

function friendlyType(mimeType: string): string {
  if (mimeType === 'application/pdf') return 'PDF 文档'
  if (mimeType.includes('wordprocessingml')) return 'Word 文档'
  if (mimeType === 'text/markdown') return 'Markdown'
  if (mimeType === 'text/html') return 'HTML 文档'
  if (mimeType.startsWith('text/')) return '文本文件'
  return '文档'
}

function fileTone(mimeType: string): string {
  if (mimeType === 'application/pdf') return 'pdf'
  if (mimeType.includes('wordprocessingml')) return 'word'
  if (mimeType === 'text/markdown') return 'markdown'
  return 'text'
}

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
.knowledge-workbench { display: flex; min-width: 0; flex-direction: column; overflow: hidden; background: var(--af-canvas); }
.workbench-toolbar { display: flex; min-height: 76px; flex: none; align-items: center; justify-content: space-between; gap: 18px; border-bottom: 1px solid var(--af-border); padding: 12px 17px; background: var(--af-surface); }
.document-identity { display: flex; min-width: 0; align-items: center; gap: 11px; }
.document-icon { display: grid; width: 40px; height: 46px; flex: none; place-items: end center; overflow: hidden; border: 1px solid var(--af-border); border-radius: 8px; padding-bottom: 6px; color: var(--af-text-muted); background: var(--af-surface-muted); font-size: 8px; font-weight: 800; }
.document-icon::before { align-self: stretch; justify-self: stretch; background: currentColor; content: ''; opacity: .12; }
.document-icon.pdf { color: var(--af-danger); }.document-icon.word { color: var(--af-cobalt); }.document-icon.markdown { color: var(--af-graphite); }
.document-identity > div { display: grid; min-width: 0; gap: 3px; }
.eyebrow { overflow: hidden; color: var(--af-text-muted); font-size: 8px; font-weight: 700; letter-spacing: .06em; text-overflow: ellipsis; white-space: nowrap; }
.document-identity strong { overflow: hidden; color: var(--af-graphite); font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.status { display: inline-flex; align-items: center; gap: 4px; color: var(--af-text-muted); font-size: 8px; }
.status i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.success { color: var(--af-success) !important; }.active { color: var(--af-cobalt) !important; }.warning { color: var(--af-warning) !important; }.danger { color: var(--af-danger) !important; }
.document-actions { display: flex; flex: none; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
button { display: inline-flex; min-height: 31px; align-items: center; justify-content: center; gap: 5px; border: 1px solid var(--af-border-strong); border-radius: 7px; padding: 5px 9px; color: var(--af-text); background: var(--af-surface); cursor: pointer; font-size: 9px; transition: border-color .15s ease, color .15s ease, background .15s ease; }
button:hover:not(:disabled) { background: var(--af-surface-muted); } button:disabled { cursor: not-allowed; opacity: .48; }
.primary-action { border-color: var(--af-cobalt); color: white; background: var(--af-cobalt); box-shadow: 0 4px 12px color-mix(in srgb, var(--af-cobalt) 16%, transparent); }
.primary-action:hover:not(:disabled) { border-color: var(--af-cobalt-hover); color: white; background: var(--af-cobalt-hover); }
.document-actions .danger:hover:not(:disabled) { border-color: var(--af-danger-border); color: var(--af-danger); background: var(--af-danger-soft); }
.workbench-tabs { display: flex; min-height: 45px; flex: none; align-items: center; gap: 3px; border-bottom: 1px solid var(--af-border); padding: 6px 13px; background: var(--af-surface); }
.workbench-tabs button { position: relative; min-height: 31px; border-color: transparent; color: var(--af-text-muted); background: transparent; }
.workbench-tabs button:hover { color: var(--af-text); background: var(--af-hover); }
.workbench-tabs button.active { color: var(--af-cobalt); background: var(--af-cobalt-soft); font-weight: 700; }
.workbench-tabs button small { display: grid; min-width: 15px; height: 15px; place-items: center; border-radius: 999px; color: inherit; background: var(--af-surface); font-size: 7px; }
.workbench-content { min-height: 0; flex: 1; overflow: auto; }
.preview-panel { min-height: 100%; padding: 20px; background: color-mix(in srgb, var(--af-canvas) 92%, var(--af-surface)); }
.preview-panel.original-preview-panel { position: relative; height: 100%; padding: 0; }
.preview-sheet { width: min(760px, 88%); min-height: 520px; margin: 0 auto; overflow: hidden; border: 1px solid var(--af-border); border-radius: 3px; color: var(--af-text); background: var(--af-surface); box-shadow: 0 10px 34px rgb(32 36 43 / 10%); }
.preview-sheet > header { display: flex; min-height: 42px; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--af-border); padding: 9px 14px; color: var(--af-text-muted); background: var(--af-surface-muted); font-size: 9px; }
.preview-sheet > header span { font-weight: 700; }.preview-sheet > header small { font-size: 8px; }
.preview-sheet pre { margin: 0; padding: 34px 42px 48px; color: var(--af-text); font-family: inherit; font-size: 12px; line-height: 1.85; white-space: pre-wrap; overflow-wrap: anywhere; }
.preview-sheet.pdf { border-top: 3px solid color-mix(in srgb, var(--af-danger) 55%, transparent); }.preview-sheet.word { border-top: 3px solid color-mix(in srgb, var(--af-cobalt) 55%, transparent); }
.preview-sheet > footer { border-top: 1px solid var(--af-border); padding: 9px 14px; color: var(--af-warning); background: var(--af-warning-soft); font-size: 8px; }
.information-panel, .versions-panel { width: min(760px, calc(100% - 40px)); margin: 20px auto; }
.detail-card, .versions-panel { overflow: hidden; border: 1px solid var(--af-border); border-radius: 11px; background: var(--af-surface); box-shadow: 0 5px 20px rgb(32 36 43 / 4%); }
.detail-card > header, .section-heading { display: grid; gap: 2px; border-bottom: 1px solid var(--af-border); padding: 11px 14px; background: var(--af-surface-muted); }
.detail-card > header span, .section-heading span { color: var(--af-text-muted); font-size: 8px; font-weight: 700; letter-spacing: .1em; }
.detail-card > header strong, .section-heading strong { color: var(--af-graphite); font-size: 11px; }
dl { display: grid; margin: 0; }
dl > div { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 12px; padding: 11px 14px; }
dl > div + div { border-top: 1px solid var(--af-border); }
dt { color: var(--af-text-muted); font-size: 9px; } dd { margin: 0; overflow-wrap: anywhere; color: var(--af-text); font-size: 10px; }
.technical-value { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 8px; }
.failure { display: flex; align-items: flex-start; gap: 8px; margin: 12px 0 0; border: 1px solid var(--af-danger-border); border-radius: 9px; padding: 10px 11px; color: var(--af-danger); background: var(--af-danger-soft); font-size: 9px; line-height: 1.5; }
.failure span { display: grid; gap: 2px; }
.section-heading { display: flex; align-items: center; justify-content: space-between; }
.section-heading > div { display: grid; gap: 2px; }.section-heading > small { color: var(--af-text-muted); font-size: 8px; }
.version-list { padding: 4px 14px 8px; }
.version-list article { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 12px 0; }
.version-list article + article { border-top: 1px solid var(--af-border); }
.version-list article > div { display: grid; gap: 3px; }.version-list strong { color: var(--af-text); font-size: 10px; }.version-list small { color: var(--af-text-muted); font-size: 8px; }
.version-marker { display: grid; width: 20px; height: 20px; place-items: center; border-radius: 50%; color: var(--af-text-muted); background: var(--af-surface-muted); }
.version-marker i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }.version-marker.success { color: var(--af-success); background: var(--af-success-soft); }.version-marker.active { color: var(--af-cobalt); background: var(--af-cobalt-soft); }.version-marker.danger { color: var(--af-danger); background: var(--af-danger-soft); }
.current-version { border-radius: 999px; padding: 3px 7px; color: var(--af-success); background: var(--af-success-soft); font-size: 7px; font-weight: 700; }
.workbench-empty { display: grid; min-height: 360px; place-items: center; align-content: center; gap: 8px; padding: 30px; color: var(--af-text-muted); text-align: center; }
.workbench-empty.compact { min-height: 220px; }.workbench-empty.fill { min-height: 100%; }.workbench-empty strong { color: var(--af-graphite); font-size: 12px; }.workbench-empty p { max-width: 300px; margin: 0; font-size: 9px; line-height: 1.6; }
.empty-icon { display: grid; width: 48px; height: 48px; place-items: center; border: 1px solid var(--af-border); border-radius: 14px; color: var(--af-text-muted); background: var(--af-surface); box-shadow: 0 5px 18px rgb(32 36 43 / 5%); font-size: 20px; }
.spin { animation: spin 1s linear infinite; }
.workbench-statusbar { display: flex; min-height: 29px; flex: none; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px solid var(--af-border); padding: 5px 12px; color: var(--af-text-muted); background: var(--af-surface); font-size: 8px; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 950px) { .workbench-toolbar { align-items: flex-start; flex-direction: column; }.document-actions { justify-content: flex-start; }.preview-sheet { width: 96%; }.information-panel, .versions-panel { width: calc(100% - 24px); margin: 12px auto; } }
</style>
