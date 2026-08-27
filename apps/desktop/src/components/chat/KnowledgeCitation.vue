<template>
  <section
    class="knowledge-citation"
    data-testid="knowledge-citation"
  >
    <header>
      <span>知识库依据 · {{ coordinateLabel }}</span>
      <button
        v-if="block.sourceAvailable"
        type="button"
        data-testid="toggle-knowledge-preview"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        {{ expanded ? '收起原文' : '查看原文' }}
      </button>
      <span
        v-else
        class="source-unavailable"
      >来源当前不可用</span>
    </header>
    <KnowledgeSourcePreview
      v-if="expanded && block.sourceAvailable"
      :preview="block.preview"
    />
  </section>
</template>

<script setup lang="ts">
import type { ChatBlock } from '@autoforge/shared'
import { computed, ref } from 'vue'
import KnowledgeSourcePreview from './KnowledgeSourcePreview.vue'

type KnowledgeCitationBlock = Extract<ChatBlock, { type: 'knowledge_citation' }>
const props = defineProps<{ block: KnowledgeCitationBlock }>()
const expanded = ref(false)
const coordinateLabel = computed(() => {
  const coordinate = props.block.coordinate
  if (coordinate.kind === 'pdf') return `第 ${coordinate.page} 页`
  if (coordinate.kind === 'text') return `第 ${coordinate.line} 行`
  if (coordinate.kind === 'docx') return coordinate.headingPath.join(' / ') || `第 ${coordinate.paragraph + 1} 段`
  return coordinate.structuralPath
})
</script>

<style scoped>
.knowledge-citation { max-width: 680px; border-left: 2px solid var(--af-cobalt); padding: 8px 10px; background: var(--af-surface-muted); font-size: 12px; }
.knowledge-citation header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.knowledge-citation button { border: 0; padding: 0; color: var(--af-cobalt); background: transparent; cursor: pointer; }
.source-unavailable { color: var(--af-text-muted); }
</style>
