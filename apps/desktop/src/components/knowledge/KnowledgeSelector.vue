<template>
  <details
    class="knowledge-selector"
    data-testid="knowledge-selector"
  >
    <summary :class="{ disabled }">
      知识库<span v-if="selectedIds.length"> · {{ selectedIds.length }}</span>
    </summary>
    <div class="knowledge-selector-popover">
      <p
        v-if="!store.bases.length"
        class="empty"
      >
        暂无可用知识库
      </p>
      <label
        v-for="base in selectableBases"
        :key="base.id"
      >
        <input
          type="checkbox"
          :checked="selectedIds.includes(base.id)"
          :disabled="disabled"
          :data-testid="`knowledge-select-${base.id}`"
          @change="toggle(base.id)"
        >
        <span>{{ base.name }}</span>
      </label>
      <label class="mode">
        <span>回答模式</span>
        <select
          :value="mode"
          :disabled="disabled || !selectedIds.length"
          data-testid="knowledge-mode"
          @change="setMode"
        >
          <option value="mixed">结合通用知识</option>
          <option value="strict">仅依据知识库</option>
        </select>
      </label>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useAuthStore } from '../../stores/auth'
import { useChatStore } from '../../stores/chat'
import { useKnowledgeStore } from '../../stores/knowledge'

defineProps<{ disabled: boolean }>()
const auth = useAuthStore()
const chat = useChatStore()
const store = useKnowledgeStore()
const selectedIds = computed(() => chat.preferences.knowledgeBaseIds ?? [])
const mode = computed(() => chat.preferences.knowledgeMode ?? 'mixed')
const selectableBases = computed(() => store.bases.filter(base => base.status !== 'recycled'))

onMounted(() => store.bindOwner(auth.session?.user.id))
watch(() => auth.session?.user.id, ownerId => store.bindOwner(ownerId))

function save(baseIds: string[], knowledgeMode = mode.value) {
  const conversationId = chat.selectedConversationId
  if (!conversationId) return
  void chat.updateGenerationPreferences(conversationId, {
    ...chat.preferences,
    knowledgeBaseIds: baseIds,
    knowledgeMode,
  })
}

function toggle(baseId: string) {
  save(selectedIds.value.includes(baseId)
    ? selectedIds.value.filter(id => id !== baseId)
    : [...selectedIds.value, baseId])
}

function setMode(event: unknown) {
  const value = String((event as { target?: { value?: unknown } }).target?.value ?? '')
  if (value === 'mixed' || value === 'strict') save(selectedIds.value, value)
}
</script>

<style scoped>
.knowledge-selector { position: relative; color: var(--af-text-muted); font-size: 11px; }
summary { list-style: none; border: 1px solid var(--af-border); border-radius: 7px; padding: 5px 8px; color: var(--af-text); background: var(--af-surface); cursor: pointer; }
summary::-webkit-details-marker { display: none; }
summary.disabled { opacity: .55; pointer-events: none; }
.knowledge-selector-popover { position: absolute; z-index: 20; bottom: calc(100% + 7px); left: 0; display: grid; width: 250px; gap: 8px; border: 1px solid var(--af-border); border-radius: 10px; padding: 12px; background: var(--af-surface); box-shadow: 0 8px 28px rgb(32 36 43 / 15%); }
label { display: flex; align-items: center; gap: 8px; color: var(--af-text); }
.mode { justify-content: space-between; border-top: 1px solid var(--af-border); padding-top: 9px; }
select { min-width: 125px; border: 1px solid var(--af-border); border-radius: 6px; padding: 4px; color: var(--af-text); background: var(--af-surface); }
.empty { margin: 0; color: var(--af-text-muted); }
</style>
