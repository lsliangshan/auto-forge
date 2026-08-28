<template>
  <section
    class="knowledge-pane"
    data-testid="knowledge-base-pane"
    aria-label="知识库列表"
  >
    <header>
      <strong>知识库</strong>
      <button
        type="button"
        data-testid="knowledge-create-toggle"
        :disabled="store.busy || !store.localAvailable || (store.entitlement?.tier === 'free' && store.bases.length > 0)"
        @click="creating = !creating"
      >
        新建
      </button>
    </header>
    <form
      v-if="creating"
      class="create-form"
      @submit.prevent="create"
    >
      <input
        v-model="name"
        aria-label="知识库名称"
        maxlength="200"
        autofocus
      >
      <button
        type="submit"
        :disabled="store.busy || !store.localAvailable || !name.trim() || (store.entitlement?.tier === 'free' && store.bases.length > 0)"
      >
        创建
      </button>
    </form>
    <div class="knowledge-list af-scrollbar">
      <button
        v-for="base in store.bases"
        :key="base.id"
        type="button"
        class="knowledge-list-item"
        :class="{ selected: base.id === store.selectedBaseId }"
        :data-testid="`knowledge-base-${base.id}`"
        @click="store.selectBase(base.id)"
      >
        <span class="af-truncate">{{ base.name }}</span>
        <small>{{ kindLabel(base.kind) }} · {{ statusLabel(base.status) }}</small>
        <small>{{ base.documentCount }} 个文档</small>
      </button>
      <p
        v-if="!store.bases.length && !store.loading"
        class="knowledge-empty"
      >
        暂无知识库
      </p>
    </div>
    <footer v-if="store.selectedBase">
      <button
        type="button"
        data-testid="knowledge-export-base"
        :disabled="store.busy || !store.localAvailable"
        @click="store.runBaseAction('export')"
      >
        导出
      </button>
      <button
        type="button"
        :data-testid="store.selectedBase.status === 'recycled' ? 'knowledge-restore-base' : 'knowledge-recycle-base'"
        :disabled="store.busy || !store.localAvailable || (store.selectedBase.status === 'recycled' && store.selectedBase.readOnly === true)"
        @click="store.runBaseAction(store.selectedBase.status === 'recycled' ? 'restore' : 'recycle')"
      >
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
    </footer>
    <p
      v-if="store.entitlement?.tier === 'free'"
      class="tier-note"
    >
      免费版：1 个本地知识库 · 1 个有效文件
    </p>
  </section>
</template>

<script setup lang="ts">
import type { KnowledgeBaseSummary } from '@autoforge/shared'
import { ElMessageBox } from 'element-plus'
import { ref } from 'vue'
import { useKnowledgeStore } from '../../stores/knowledge'

const store = useKnowledgeStore()
const creating = ref(false)
const name = ref('')
const purgePending = ref(false)
const baseLabels: Record<KnowledgeBaseSummary['status'], string> = {
  ready: '可检索', processing: '处理中', paused: '已暂停', failed: '处理失败',
  read_only: '只读', recycled: '回收站',
}
const statusLabel = (status: KnowledgeBaseSummary['status']) => baseLabels[status]
const kindLabel = (kind: KnowledgeBaseSummary['kind']) => kind === 'local' ? '本地' : '云端'
async function create() {
  const value = name.value.trim()
  if (!value) return
  await store.createBase(value)
  if (!store.error) {
    name.value = ''
    creating.value = false
  }
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
.knowledge-pane { display: flex; min-width: 0; flex-direction: column; border-right: 1px solid var(--af-border); background: var(--af-surface); }
header, footer { display: flex; min-height: 48px; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--af-border); }
footer { flex-wrap: wrap; border-top: 1px solid var(--af-border); border-bottom: 0; }
button { border: 1px solid var(--af-border); border-radius: 7px; padding: 5px 8px; color: var(--af-text); background: var(--af-surface); cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .55; }
.create-form { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; border-bottom: 1px solid var(--af-border); padding: 8px; }
.create-form input { min-width: 0; border: 1px solid var(--af-border-strong); border-radius: 7px; padding: 6px 8px; color: var(--af-text); background: var(--af-surface); }
.knowledge-list { min-height: 0; flex: 1; overflow: auto; padding: 8px; }
.knowledge-list-item { display: grid; width: 100%; gap: 4px; margin-bottom: 5px; padding: 10px; text-align: left; }
.knowledge-list-item.selected { border-color: var(--af-cobalt); background: var(--af-cobalt-soft); }
small, .knowledge-empty { color: var(--af-text-muted); }
.knowledge-empty { padding: 14px; font-size: 12px; text-align: center; }
.danger { color: var(--af-danger); }
.tier-note { margin: 0; border-top: 1px solid var(--af-border); padding: 8px 12px; color: var(--af-text-muted); font-size: 10px; }
</style>
