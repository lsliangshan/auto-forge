<template>
  <section
    class="knowledge-citation"
    data-testid="knowledge-citation"
  >
    <header>
      <span>知识库依据 · {{ coordinateLabel }}</span>
      <button
        v-if="!block.legacyUnavailable"
        type="button"
        data-testid="toggle-knowledge-preview"
        :aria-expanded="expanded"
        @click="togglePreview"
      >
        {{ expanded ? '收起原文' : '查看原文' }}
      </button>
    </header>
    <p
      v-if="block.legacyUnavailable"
      class="source-unavailable"
    >
      来源当前不可用
    </p>
    <KnowledgeSourcePreview
      v-if="expanded && preview"
      :preview="preview"
    />
    <p v-else-if="expanded && loading">
      正在读取原文…
    </p>
    <p
      v-else-if="expanded && unavailable"
      class="source-unavailable"
    >
      来源当前不可用
    </p>
  </section>
</template>

<script setup lang="ts">
import type { ChatBlock } from '@autoforge/shared'
import { computed, ref } from 'vue'
import KnowledgeSourcePreview from './KnowledgeSourcePreview.vue'
import { getDesktopApi } from '../../services/desktop-api'

type KnowledgeCitationBlock = Extract<ChatBlock, { type: 'knowledge_citation' }>
const props = defineProps<{ block: KnowledgeCitationBlock }>()
const expanded = ref(false)
const preview = ref('')
const loading = ref(false)
const unavailable = ref(false)
async function togglePreview() {
  if (expanded.value) {
    expanded.value = false
    return
  }
  expanded.value = true
  loading.value = true
  preview.value = ''
  unavailable.value = false
  try {
    const coordinate = props.block.coordinate.kind === 'docx'
      ? { ...props.block.coordinate, headingPath: [...props.block.coordinate.headingPath] }
      : { ...props.block.coordinate }
    const result = await getDesktopApi().knowledge.getSourcePreview({
      evidenceId: props.block.evidenceId,
      baseId: props.block.baseId,
      documentId: props.block.documentId,
      versionId: props.block.versionId,
      coordinate,
    })
    if (result.kind === 'available') preview.value = result.preview
    else unavailable.value = true
  } catch {
    unavailable.value = true
  } finally {
    loading.value = false
  }
}
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
