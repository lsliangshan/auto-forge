<template>
  <div class="knowledge-selector" data-testid="knowledge-selector">
    <div class="knowledge-selector-heading">
      <span>知识库</span>
      <small v-if="knowledge.entitlement?.status === 'expired'">会员已过期</small>
      <small v-else-if="knowledge.entitlement?.status === 'unavailable'">权益不可用</small>
      <small v-else>{{ selection.knowledgeBaseIds.length ? `已选 ${selection.knowledgeBaseIds.length} 个` : '未选择' }}</small>
    </div>
    <div class="knowledge-options" role="group" aria-label="当前会话知识库">
      <button
        v-for="choice in choices"
        :key="choice.base.id"
        type="button"
        role="checkbox"
        :data-testid="`knowledge-base-${choice.base.id}`"
        :aria-checked="selection.knowledgeBaseIds.includes(choice.base.id)"
        :disabled="disabled || (choice.disabled && !selection.knowledgeBaseIds.includes(choice.base.id))"
        :title="choice.label"
        @click="toggleBase(choice.base.id)"
      >
        <span>{{ choice.base.name }}</span>
        <small>{{ choice.label }}</small>
      </button>
      <span v-if="!choices.length" class="knowledge-empty">
        {{ knowledge.availability && !knowledge.availability.local.available ? '不可用' : '暂无知识库' }}
      </span>
    </div>
    <div class="knowledge-modes" role="radiogroup" aria-label="知识库回答模式">
      <button
        type="button"
        role="radio"
        data-testid="knowledge-mode-mixed"
        :aria-checked="selection.knowledgeMode === 'mixed'"
        :disabled="disabled"
        @click="setMode('mixed')"
      >混合（默认）</button>
      <button
        type="button"
        role="radio"
        data-testid="knowledge-mode-strict"
        :aria-checked="selection.knowledgeMode === 'strict'"
        :disabled="disabled"
        @click="setMode('strict')"
      >严格</button>
    </div>
    <p v-if="chat.knowledgeSelectionError || knowledge.operationError" class="knowledge-selector-error" role="alert">
      {{ chat.knowledgeSelectionError || knowledge.operationError }}
    </p>
  </div>
</template>

<script setup lang="ts">
import type { KnowledgeBase, KnowledgeSelection } from '@autoforge/shared'
import { computed, watch } from 'vue'
import { useChatStore } from '../../stores/chat'
import { useKnowledgeStore } from '../../stores/knowledge'

defineProps<{ disabled: boolean }>()
const chat = useChatStore()
const knowledge = useKnowledgeStore()
const selection = computed(() => chat.knowledgeSelection)

type Choice = { base: KnowledgeBase; label: string; disabled: boolean }

function choiceFor(base: KnowledgeBase, missing = false): Choice {
  if (missing) return { base, label: '已删除或不可用', disabled: true }
  if (base.status === 'recycled') return { base, label: '已删除或不可用', disabled: true }
  const scopeUsable = base.kind === 'local'
    ? knowledge.availability?.local.available
    : knowledge.availability?.cloud.available && knowledge.entitlement?.cloudEnabled
  if (!scopeUsable) {
    return { base, label: '不可用', disabled: true }
  }
  if (!knowledge.entitlement
    || !['active', 'offline_grace'].includes(knowledge.entitlement.status)) {
    const reason = knowledge.entitlement?.status === 'expired' ? '会员已过期' : '权益不可用'
    const state = base.status === 'processing'
      ? `${base.kind === 'cloud' ? '同步中' : '本地处理中'} · `
      : base.status === 'read_only'
        ? '只读 · '
        : base.status === 'failed'
          ? '处理失败 · '
          : base.status === 'paused'
            ? '同步已暂停 · '
            : base.kind === 'cloud' ? '已同步 · ' : ''
    return { base, label: `${state}${reason}`, disabled: true }
  }
  if (base.status === 'read_only') return { base, label: '只读 · 不可检索（可导出或删除）', disabled: true }
  if (!base.searchable) {
    const state = base.status === 'processing'
      ? (base.kind === 'cloud' ? '同步中' : '本地处理中')
      : base.status === 'failed'
        ? '处理失败'
        : base.status === 'paused'
          ? '同步已暂停'
          : '尚无内容'
    return { base, label: `${state} · 暂无已就绪版本`, disabled: true }
  }
  if (base.status === 'failed') return { base, label: '处理失败 · 已就绪版本可用', disabled: false }
  if (base.status === 'paused') return { base, label: '同步已暂停 · 已就绪版本可用', disabled: false }
  if (base.status === 'processing') {
    return { base, label: `${base.kind === 'cloud' ? '同步中' : '本地处理中'} · 已就绪版本可用`, disabled: false }
  }
  if (base.kind === 'local') return { base, label: '仅本地 · 关键词检索', disabled: false }
  return {
    base,
    label: knowledge.consent?.status === 'granted' ? '已同步' : '已同步 · 关键词检索',
    disabled: false,
  }
}

const choices = computed<Choice[]>(() => {
  const known = new Set(knowledge.bases.map(({ id }) => id))
  const current = knowledge.bases.map((base) => choiceFor(base))
  for (const id of selection.value.knowledgeBaseIds) {
    if (known.has(id)) continue
    current.push(choiceFor({
      id, name: id, kind: 'local', status: 'recycled', searchable: false, documentCount: 0,
      updatedAt: new Date(0).toISOString(),
    }, true))
  }
  return current
})

function save(next: KnowledgeSelection) {
  const conversationId = chat.selectedConversationId
  if (conversationId) void chat.updateKnowledgeSelection(conversationId, next)
}

function toggleBase(id: string) {
  const selected = selection.value.knowledgeBaseIds
  save({
    knowledgeBaseIds: selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id],
    knowledgeMode: selection.value.knowledgeMode,
  })
}

function setMode(knowledgeMode: KnowledgeSelection['knowledgeMode']) {
  if (knowledgeMode === selection.value.knowledgeMode) return
  save({ knowledgeBaseIds: [...selection.value.knowledgeBaseIds], knowledgeMode })
}

watch(() => chat.selectedConversationId, (conversationId) => {
  if (!conversationId) return
  void Promise.all([
    knowledge.loadSelectorCatalog(),
    chat.loadKnowledgeSelection(conversationId),
  ])
}, { immediate: true })
</script>

<style scoped>
.knowledge-selector { display: grid; gap: 6px; margin-bottom: 9px; border: 1px solid var(--af-border); border-radius: 7px; padding: 8px 9px; background: var(--af-surface-muted); }
.knowledge-selector-heading { display: flex; align-items: center; justify-content: space-between; color: var(--af-text); font-size: 11px; font-weight: 650; }.knowledge-selector-heading small { color: var(--af-text-muted); font-weight: 500; }
.knowledge-options { display: flex; gap: 6px; overflow-x: auto; }.knowledge-options button { display: grid; min-width: 116px; gap: 2px; border: 1px solid var(--af-border-strong); border-radius: 6px; padding: 5px 7px; color: var(--af-text); background: var(--af-surface); cursor: pointer; text-align: left; }.knowledge-options button[aria-checked='true'] { border-color: var(--af-cobalt); color: var(--af-cobalt); background: var(--af-cobalt-soft); }.knowledge-options button:disabled { cursor: not-allowed; opacity: .58; }.knowledge-options small { color: var(--af-text-muted); font-size: 9px; }.knowledge-empty { color: var(--af-text-muted); font-size: 10px; }
.knowledge-modes { display: flex; gap: 5px; }.knowledge-modes button { border: 0; border-radius: 999px; padding: 3px 8px; color: var(--af-text-muted); background: transparent; cursor: pointer; font-size: 10px; }.knowledge-modes button[aria-checked='true'] { color: var(--af-cobalt); background: var(--af-cobalt-soft); }.knowledge-modes button:disabled { cursor: not-allowed; opacity: .55; }
.knowledge-selector-error { margin: 0; color: var(--af-danger); font-size: 10px; }
</style>
