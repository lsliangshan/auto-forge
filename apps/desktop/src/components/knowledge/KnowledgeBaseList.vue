<template>
  <aside
    class="knowledge-explorer"
    data-testid="knowledge-tree"
    aria-label="知识资源树"
  >
    <header class="explorer-header">
      <div>
        <span>EXPLORER</span>
        <strong>知识资源</strong>
      </div>
      <div class="header-actions">
        <button
          type="button"
          data-testid="knowledge-create-toggle"
          :disabled="store.busy || !store.localAvailable || store.baseLimitReached"
          :title="store.baseLimitReached ? '当前会员版本的知识库数量已达上限' : '新建知识库'"
          aria-label="新建知识库"
          @click="openCreate"
        >
          <el-icon><FolderAdd /></el-icon>
        </button>
        <button
          type="button"
          data-testid="knowledge-import"
          :disabled="importDisabled"
          :title="importTitle"
          aria-label="导入文档"
          @click="store.importDocuments"
        >
          <el-icon><Upload /></el-icon>
        </button>
      </div>
    </header>

    <div class="tree af-scrollbar">
      <template
        v-for="base in store.bases"
        :key="base.id"
      >
        <button
          type="button"
          class="tree-row base-row"
          :class="{ selected: base.id === store.selectedBaseId && expandedBaseId !== base.id }"
          :data-testid="`knowledge-base-${base.id}`"
          :aria-expanded="expandedBaseId === base.id"
          @click="selectOrToggleBase(base.id)"
        >
          <el-icon class="chevron">
            <ArrowDown v-if="expandedBaseId === base.id" /><ArrowRight v-else />
          </el-icon>
          <el-icon class="node-icon">
            <FolderOpened v-if="expandedBaseId === base.id" /><Folder v-else />
          </el-icon>
          <span class="node-copy">
            <strong class="af-truncate">{{ base.name }}</strong>
            <small>{{ kindLabel(base.kind) }} · {{ statusLabel(base.status) }}</small>
          </span>
          <small class="node-count">{{ base.documentCount }}</small>
        </button>

        <div
          v-if="expandedBaseId === base.id"
          class="tree-children"
        >
          <button
            v-for="document in store.documents"
            :key="document.id"
            type="button"
            class="tree-row document-row"
            :class="{ selected: document.id === store.selectedDocumentId }"
            :data-testid="`knowledge-document-${document.id}`"
            :aria-current="document.id === store.selectedDocumentId ? 'true' : undefined"
            @click="store.selectDocument(document.id)"
          >
            <span class="tree-guide" />
            <span
              class="file-kind"
              :class="fileTone(document.mimeType)"
            >{{ fileExtension(document.name) }}</span>
            <span class="node-copy">
              <strong class="af-truncate">{{ document.name }}</strong>
              <small :class="statusTone(document.status)">{{ document.readOnly ? '只读' : documentStatusLabel(document.status) }}</small>
            </span>
            <i
              class="status-dot"
              :class="statusTone(document.status)"
            />
          </button>

          <div
            v-if="store.loading && !store.documents.length"
            class="tree-message"
          >
            <el-icon class="spin">
              <Loading />
            </el-icon>
            正在加载文档
          </div>
          <div
            v-else-if="!store.documents.length"
            class="tree-empty"
          >
            <span>还没有文档</span>
            <button
              type="button"
              data-testid="knowledge-empty-import"
              :disabled="importDisabled"
              :title="importTitle"
              @click="store.importDocuments"
            >
              导入第一个文档
            </button>
          </div>
        </div>
      </template>

      <div
        v-if="store.loading && !store.bases.length"
        class="explorer-empty"
      >
        <el-icon class="spin">
          <Loading />
        </el-icon>
        <strong>正在加载知识库</strong>
      </div>
      <div
        v-else-if="!store.bases.length"
        class="explorer-empty"
      >
        <span class="empty-icon"><el-icon><FolderAdd /></el-icon></span>
        <strong>创建第一个知识库</strong>
        <p>知识库会作为文件树的顶层目录。</p>
        <button
          type="button"
          data-testid="knowledge-empty-create"
          :disabled="store.busy || !store.localAvailable || store.baseLimitReached"
          @click="openCreate"
        >
          新建知识库
        </button>
      </div>
    </div>

    <footer
      v-if="store.selectedBase"
      class="explorer-footer"
    >
      <div class="base-actions">
        <button
          type="button"
          data-testid="knowledge-export-base"
          :disabled="store.busy || !store.localAvailable"
          title="导出知识库"
          @click="store.runBaseAction('export')"
        >
          <el-icon><Download /></el-icon>导出
        </button>
        <button
          type="button"
          :class="{ danger: store.selectedBase.status !== 'recycled' }"
          :data-testid="store.selectedBase.status === 'recycled' ? 'knowledge-restore-base' : 'knowledge-recycle-base'"
          :disabled="store.busy || !store.localAvailable || (store.selectedBase.status === 'recycled' && store.selectedBase.readOnly === true)"
          @click="store.runBaseAction(store.selectedBase.status === 'recycled' ? 'restore' : 'recycle')"
        >
          <el-icon><RefreshLeft v-if="store.selectedBase.status === 'recycled'" /><Delete v-else /></el-icon>
          {{ store.selectedBase.status === 'recycled' ? '恢复' : '回收' }}
        </button>
        <button
          v-if="store.selectedBase.status === 'recycled'"
          type="button"
          class="danger"
          data-testid="knowledge-purge-base"
          :aria-label="`永久删除知识库 ${store.selectedBase.name}`"
          :disabled="store.busy || purgePending || !store.localAvailable"
          @click="purgeBase"
        >
          永久删除
        </button>
      </div>
      <p v-if="store.entitlement?.tier === 'free'">
        免费版：1 个本地知识库 · 1 个未永久删除的文件
      </p>
    </footer>
  </aside>

  <Teleport to="body">
    <Transition name="knowledge-create-dialog">
      <div
        v-if="creating"
        class="create-dialog-backdrop"
        data-testid="knowledge-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="knowledge-create-title"
        aria-describedby="knowledge-create-description"
        @mousedown.self="closeCreate"
        @keydown.esc.prevent.stop="closeCreate"
        @keydown.tab="trapCreateFocus"
      >
        <form
          ref="createDialog"
          class="create-dialog"
          :aria-busy="store.busy"
          @submit.prevent="create"
        >
          <header class="create-dialog-header">
            <span class="create-dialog-icon"><el-icon><FolderAdd /></el-icon></span>
            <div>
              <h2 id="knowledge-create-title">
                新建知识库
              </h2>
              <p id="knowledge-create-description">
                创建一个独立空间，用于整理和检索相关文档。
              </p>
            </div>
            <button
              type="button"
              class="dialog-close"
              aria-label="关闭新建知识库弹窗"
              title="关闭"
              :disabled="store.busy"
              @click="closeCreate"
            >
              <el-icon><Close /></el-icon>
            </button>
          </header>

          <div class="create-dialog-body">
            <label for="knowledge-base-name">知识库名称</label>
            <div class="name-field">
              <input
                id="knowledge-base-name"
                ref="nameInput"
                v-model="name"
                aria-label="知识库名称"
                maxlength="200"
                autocomplete="off"
                placeholder="例如：项目资料"
              >
              <span>{{ name.length }}/200</span>
            </div>
            <p class="field-hint">
              名称应简洁明确，创建后可继续导入 PDF、Word、TXT 等文档。
            </p>
            <p
              v-if="store.entitlement?.tier === 'free'"
              class="quota-hint"
            >
              免费版可创建 1 个本地知识库。
            </p>
            <p
              v-if="store.error"
              class="create-dialog-error"
              role="alert"
            >
              {{ store.error }}
            </p>
          </div>

          <footer class="create-dialog-footer">
            <span>按 Esc 取消</span>
            <div>
              <button
                type="button"
                :disabled="store.busy"
                @click="closeCreate"
              >
                取消
              </button>
              <button
                type="submit"
                class="primary-action"
                :disabled="store.busy || !store.localAvailable || !name.trim() || store.baseLimitReached"
              >
                {{ store.busy ? '正在创建…' : '创建知识库' }}
              </button>
            </div>
          </footer>
        </form>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import type { KnowledgeBaseSummary, KnowledgeDocumentSummary } from '@autoforge/shared'
import {
  ArrowDown,
  ArrowRight,
  Close,
  Delete,
  Download,
  Folder,
  FolderAdd,
  FolderOpened,
  Loading,
  RefreshLeft,
  Upload,
} from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import { computed, nextTick, ref, watch } from 'vue'
import { KNOWLEDGE_DOCUMENT_LIMIT_MESSAGE, useKnowledgeStore } from '../../stores/knowledge'

const store = useKnowledgeStore()
const creating = ref(false)
const name = ref('')
const nameInput = ref<globalThis.HTMLInputElement>()
const createDialog = ref<globalThis.HTMLFormElement>()
const purgePending = ref(false)
const expandedBaseId = ref('')
let createTrigger: globalThis.HTMLButtonElement | undefined
const baseLabels: Record<KnowledgeBaseSummary['status'], string> = {
  ready: '可检索', processing: '处理中', paused: '已暂停', failed: '处理失败',
  read_only: '只读', recycled: '回收站',
}
const documentLabels: Record<KnowledgeDocumentSummary['status'], string> = {
  queued: '等待处理', copying: '正在复制', parsing: '正在解析', indexing: '正在索引',
  ready: '可检索', failed: '处理失败', paused: '已暂停', deleted: '回收站',
}
const importDisabled = computed(() => !store.selectedBaseId || store.busy || !store.localAvailable
  || store.selectedBase?.readOnly === true || store.documentLimitReached)
const importTitle = computed(() => store.documentLimitReached ? KNOWLEDGE_DOCUMENT_LIMIT_MESSAGE : '导入文档')

watch(() => store.selectedBaseId, (baseId) => {
  if (baseId) expandedBaseId.value = baseId
}, { immediate: true })

const statusLabel = (status: KnowledgeBaseSummary['status']) => baseLabels[status]
const documentStatusLabel = (status: KnowledgeDocumentSummary['status']) => documentLabels[status]
const kindLabel = (kind: KnowledgeBaseSummary['kind']) => kind === 'local' ? '本地' : '云端'
const statusTone = (status: KnowledgeDocumentSummary['status']) => ({
  queued: 'active', copying: 'active', parsing: 'active', indexing: 'active', ready: 'success',
  failed: 'danger', paused: 'warning', deleted: 'neutral',
})[status]

function selectOrToggleBase(baseId: string) {
  if (baseId === store.selectedBaseId) {
    expandedBaseId.value = expandedBaseId.value === baseId ? '' : baseId
    return
  }
  expandedBaseId.value = baseId
  void store.selectBase(baseId)
}

function fileExtension(value: string): string {
  const extension = value.split('.').pop()?.toUpperCase()
  return extension && extension.length <= 5 ? extension : 'FILE'
}

function fileTone(mimeType: string): string {
  if (mimeType === 'application/pdf') return 'pdf'
  if (mimeType.includes('wordprocessingml')) return 'word'
  if (mimeType === 'text/markdown') return 'markdown'
  return 'text'
}

async function openCreate(event?: globalThis.MouseEvent) {
  if (creating.value) return
  if (event?.currentTarget instanceof globalThis.HTMLButtonElement) createTrigger = event.currentTarget
  creating.value = true
  await nextTick()
  nameInput.value?.focus()
}

function closeCreate() {
  if (store.busy) return
  creating.value = false
  name.value = ''
  void nextTick(() => {
    if (createTrigger?.isConnected) createTrigger.focus()
    createTrigger = undefined
  })
}

function trapCreateFocus(event: KeyboardEvent) {
  const focusable = Array.from(createDialog.value?.querySelectorAll<globalThis.HTMLElement>(
    'input, button:not(:disabled)',
  ) ?? [])
  const first = focusable[0]
  const last = focusable.at(-1)
  if (!first || !last) return
  if (event.shiftKey && globalThis.document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && globalThis.document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

async function create() {
  const value = name.value.trim()
  if (!value || store.busy) return
  await store.createBase(value)
  if (!store.error) closeCreate()
}

async function purgeBase() {
  const selected = store.selectedBase
  if (!selected || selected.status !== 'recycled' || purgePending.value) return
  const ownerToken = store.captureOwnerToken()
  if (!ownerToken) return
  const baseId = selected.id
  purgePending.value = true
  try {
    await ElMessageBox.confirm(
      `永久删除“${selected.name}”及其全部文件和版本？此操作无法撤销。`,
      '永久删除知识库',
      { type: 'warning', confirmButtonText: '永久删除', cancelButtonText: '取消' },
    )
    if (!store.isOwnerTokenCurrent(ownerToken) || store.selectedBaseId !== baseId) return
    await store.runBaseAction('purge')
  } catch {
    // Cancellation is an expected terminal result.
  } finally {
    purgePending.value = false
  }
}
</script>

<style scoped>
.knowledge-explorer { display: flex; min-width: 0; flex-direction: column; border-right: 1px solid var(--af-border); background: var(--af-surface); }
.explorer-header { display: flex; min-height: 58px; align-items: center; justify-content: space-between; gap: 10px; border-bottom: 1px solid var(--af-border); padding: 9px 11px 9px 13px; }
.explorer-header > div:first-child { display: grid; gap: 2px; }
.explorer-header span { color: var(--af-text-muted); font-size: var(--af-knowledge-font-caption); font-weight: 750; letter-spacing: .12em; }
.explorer-header strong { color: var(--af-graphite); font-size: var(--af-knowledge-font-label); }
.header-actions, .base-actions { display: flex; align-items: center; gap: 5px; }
button { display: inline-flex; min-height: 29px; align-items: center; justify-content: center; gap: 5px; border: 1px solid var(--af-border); border-radius: 7px; padding: 5px 8px; color: var(--af-text); background: var(--af-surface); cursor: pointer; font-size: var(--af-knowledge-font-small); transition: border-color .15s ease, color .15s ease, background .15s ease; }
button:hover:not(:disabled) { border-color: var(--af-border-strong); background: var(--af-surface-muted); }
button:disabled { cursor: not-allowed; opacity: .48; }
.header-actions button { width: 29px; padding: 0; color: var(--af-text-muted); }
.header-actions button:hover:not(:disabled) { color: var(--af-cobalt); background: var(--af-cobalt-soft); }
.primary-action { border-color: var(--af-cobalt); color: white; background: var(--af-cobalt); }
.primary-action:hover:not(:disabled) { border-color: var(--af-cobalt-hover); color: white; background: var(--af-cobalt-hover); }
.tree { min-height: 0; flex: 1; overflow: auto; padding: 7px; }
.tree-row { display: grid; width: 100%; min-height: 39px; grid-template-columns: 16px 25px minmax(0, 1fr) auto; align-items: center; gap: 4px; border-color: transparent; padding: 5px 7px; text-align: left; }
.tree-row:hover:not(:disabled) { border-color: transparent; background: var(--af-hover); }
.tree-row.selected { border-color: color-mix(in srgb, var(--af-cobalt) 24%, transparent); color: var(--af-cobalt); background: var(--af-cobalt-soft); }
.chevron { color: var(--af-text-muted); font-size: 0.625rem; }
.node-icon { color: var(--af-cobalt); font-size: 0.9375rem; }
.node-copy { display: grid; min-width: 0; gap: 2px; }
.node-copy strong { color: var(--af-graphite); font-size: var(--af-knowledge-font-body); font-weight: 680; }
.selected .node-copy strong { color: var(--af-cobalt); }
.node-copy small, .node-count { color: var(--af-text-muted); font-size: var(--af-knowledge-font-caption); }
.node-count { padding-right: 2px; }
.tree-children { position: relative; }
.tree-children::before { position: absolute; top: 0; bottom: 7px; left: 19px; width: 1px; background: var(--af-border); content: ''; }
.document-row { min-height: 43px; padding-left: 7px; }
.tree-guide { position: relative; width: 16px; height: 100%; }
.tree-guide::after { position: absolute; top: 50%; left: 12px; width: 10px; height: 1px; background: var(--af-border); content: ''; }
.file-kind { display: grid; width: 24px; height: 27px; place-items: center; border-radius: 5px; color: var(--af-text-muted); background: var(--af-surface-muted); font-size: var(--af-knowledge-font-caption); font-weight: 800; }
.file-kind.pdf { color: var(--af-danger); background: var(--af-danger-soft); }.file-kind.word { color: var(--af-cobalt); background: var(--af-cobalt-soft); }
.status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--af-text-muted); }
.success { color: var(--af-success) !important; }.status-dot.success { background: var(--af-success); }.active { color: var(--af-cobalt) !important; }.status-dot.active { background: var(--af-cobalt); }.warning { color: var(--af-warning) !important; }.status-dot.warning { background: var(--af-warning); }.danger { color: var(--af-danger) !important; }.status-dot.danger { background: var(--af-danger); }
.tree-message, .tree-empty { display: flex; min-height: 54px; align-items: center; justify-content: center; gap: 7px; margin-left: 19px; color: var(--af-text-muted); font-size: var(--af-knowledge-font-small); }
.tree-empty { flex-direction: column; }
.tree-empty button { color: var(--af-cobalt); }
.explorer-empty { display: grid; min-height: 240px; place-items: center; align-content: center; gap: 8px; padding: 18px; color: var(--af-text-muted); text-align: center; }
.explorer-empty strong { color: var(--af-graphite); font-size: var(--af-knowledge-font-label); }.explorer-empty p { margin: 0; font-size: var(--af-knowledge-font-small); line-height: 1.5; }
.empty-icon { display: grid; width: 42px; height: 42px; place-items: center; border-radius: 12px; color: var(--af-cobalt); background: var(--af-cobalt-soft); font-size: 1.1875rem; }
.explorer-empty button { color: var(--af-cobalt); font-weight: 700; }
.spin { animation: spin 1s linear infinite; }
.explorer-footer { display: grid; gap: 7px; border-top: 1px solid var(--af-border); padding: 9px 10px; background: var(--af-surface-muted); }
.base-actions { flex-wrap: wrap; }
.base-actions button { min-height: 27px; padding: 4px 7px; }
.base-actions .danger:hover:not(:disabled) { border-color: var(--af-danger-border); background: var(--af-danger-soft); }
.explorer-footer p { margin: 0; color: var(--af-text-muted); font-size: var(--af-knowledge-font-caption); line-height: 1.45; }
.create-dialog-backdrop { --af-knowledge-font-caption: 0.625rem; --af-knowledge-font-small: 0.6875rem; --af-knowledge-font-body: 0.75rem; --af-knowledge-font-label: 0.8125rem; position: fixed; z-index: 3600; display: grid; padding: 28px; background: rgb(15 23 42 / 48%); inset: 0; place-items: center; backdrop-filter: blur(3px); }
.create-dialog { width: min(520px, calc(100vw - 40px)); overflow: hidden; border: 1px solid color-mix(in srgb, var(--af-border-strong) 74%, transparent); border-radius: 18px; background: var(--af-surface); box-shadow: 0 28px 80px rgb(15 23 42 / 28%), 0 8px 24px rgb(15 23 42 / 12%); }
.create-dialog-header { display: grid; grid-template-columns: 46px minmax(0, 1fr) 34px; align-items: start; gap: 14px; border-bottom: 1px solid color-mix(in srgb, var(--af-border) 82%, transparent); padding: 24px; background: linear-gradient(135deg, var(--af-surface) 62%, color-mix(in srgb, var(--af-cobalt-soft) 52%, var(--af-surface))); }
.create-dialog-icon { display: grid; width: 46px; height: 46px; place-items: center; border: 1px solid color-mix(in srgb, var(--af-cobalt) 22%, var(--af-border)); border-radius: 13px; color: var(--af-cobalt); background: var(--af-cobalt-soft); box-shadow: 0 6px 16px color-mix(in srgb, var(--af-cobalt) 10%, transparent); font-size: 1.25rem; }
.create-dialog-header h2 { margin: 0 0 6px; color: var(--af-graphite); font-size: 1.0625rem; line-height: 1.3; }
.create-dialog-header p { max-width: 360px; margin: 0; color: var(--af-text-muted); font-size: var(--af-knowledge-font-body); line-height: 1.6; }
.create-dialog .dialog-close { width: 34px; min-height: 34px; border-color: transparent; border-radius: 10px; padding: 0; color: var(--af-text-muted); background: transparent; }
.create-dialog .dialog-close:hover:not(:disabled) { border-color: color-mix(in srgb, var(--af-border) 75%, transparent); color: var(--af-text); background: color-mix(in srgb, var(--af-surface-muted) 82%, transparent); }
.create-dialog-body { display: grid; gap: 9px; padding: 24px 24px 26px; }
.create-dialog-body label { color: var(--af-graphite); font-size: var(--af-knowledge-font-label); font-weight: 720; }
.name-field { position: relative; }
.name-field input { width: 100%; min-width: 0; min-height: 46px; box-sizing: border-box; border: 1px solid var(--af-border-strong); border-radius: 10px; padding: 11px 62px 11px 13px; color: var(--af-text); background: var(--af-surface); font-size: var(--af-knowledge-font-label); transition: border-color .15s ease, box-shadow .15s ease, background .15s ease; }
.name-field input::placeholder { color: color-mix(in srgb, var(--af-text-muted) 72%, transparent); }
.name-field input:focus { border-color: var(--af-cobalt); outline: none; box-shadow: var(--af-focus); }
.name-field span { position: absolute; top: 50%; right: 13px; color: var(--af-text-muted); font-size: var(--af-knowledge-font-caption); font-variant-numeric: tabular-nums; transform: translateY(-50%); }
.field-hint, .quota-hint, .create-dialog-error { margin: 0; color: var(--af-text-muted); font-size: var(--af-knowledge-font-small); line-height: 1.55; }
.quota-hint { border: 1px solid color-mix(in srgb, var(--af-cobalt) 12%, transparent); border-radius: 9px; padding: 8px 10px; color: var(--af-cobalt); background: color-mix(in srgb, var(--af-cobalt-soft) 65%, var(--af-surface)); }
.create-dialog-error { color: var(--af-danger); }
.create-dialog-footer { display: flex; min-height: 68px; align-items: center; justify-content: space-between; gap: 16px; border-top: 1px solid var(--af-border); padding: 14px 24px; background: color-mix(in srgb, var(--af-surface-muted) 86%, var(--af-surface)); }
.create-dialog-footer > span { color: var(--af-text-muted); font-size: var(--af-knowledge-font-caption); }
.create-dialog-footer > div { display: flex; gap: 9px; }
.create-dialog-footer button { min-width: 76px; min-height: 38px; border-radius: 9px; padding: 8px 14px; font-size: var(--af-knowledge-font-body); }
.create-dialog-footer .primary-action { min-width: 104px; font-weight: 700; box-shadow: 0 5px 12px color-mix(in srgb, var(--af-cobalt) 18%, transparent); }
.create-dialog-footer .primary-action:disabled { box-shadow: none; }
.knowledge-create-dialog-enter-active, .knowledge-create-dialog-leave-active { transition: opacity .16s ease; }
.knowledge-create-dialog-enter-active .create-dialog, .knowledge-create-dialog-leave-active .create-dialog { transition: transform .16s ease, opacity .16s ease; }
.knowledge-create-dialog-enter-from, .knowledge-create-dialog-leave-to { opacity: 0; }
.knowledge-create-dialog-enter-from .create-dialog, .knowledge-create-dialog-leave-to .create-dialog { opacity: 0; transform: translateY(8px) scale(.985); }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
