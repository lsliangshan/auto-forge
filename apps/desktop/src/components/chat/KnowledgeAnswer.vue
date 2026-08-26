<template>
  <section class="knowledge-answer" data-testid="knowledge-answer">
    <ol class="knowledge-claims">
      <li v-for="(claim, claimIndex) in block.claims" :key="claimIndex" data-testid="knowledge-claim">
        <span>{{ claim.text }}</span>
        <span v-if="claim.support === 'general'" class="general-label">通用知识（未由知识库支持）</span>
        {{ claim.citations.length ? ' ' : '' }}
        <button
          v-for="citation in claim.citations"
          :key="citationKey(citation)"
          type="button"
          class="citation-link"
          :data-testid="`knowledge-citation-${citationIndex(citation)}`"
          :aria-label="`查看来源 ${citationIndex(citation) + 1}`"
          @click="openPreview(citationIndex(citation))"
        >[{{ citationIndex(citation) + 1 }}]</button>
      </li>
    </ol>

    <details class="knowledge-sources" open>
      <summary data-testid="knowledge-sources-summary">来源 {{ sources.length }}</summary>
      <ol>
        <li v-for="(source, index) in sources" :key="citationKey(source)">
          <button
            type="button"
            class="source-link"
            :data-testid="`knowledge-source-${index}`"
            @click="openPreview(index)"
          >[{{ index + 1 }}] {{ coordinateLabel(source) }}</button>
        </li>
      </ol>
    </details>

    <aside
      v-if="previewOpen"
      ref="previewDialog"
      class="citation-preview"
      data-testid="knowledge-citation-preview"
      role="dialog"
      aria-modal="true"
      aria-label="知识库来源预览"
      tabindex="-1"
      @keydown.esc.stop.prevent="closePreview"
    >
      <header>
        <strong>来源 {{ activeCitationIndex + 1 }}</strong>
        <button type="button" aria-label="关闭来源预览" @click="closePreview">关闭</button>
      </header>
      <p v-if="previewLoading">正在加载来源…</p>
      <p v-else-if="preview?.status === 'unavailable'" role="status">来源已不可用，可能已被删除或清除。</p>
      <template v-else-if="preview?.status === 'available'">
        <p class="preview-coordinate">{{ previewCoordinateLabel }}</p>
        <blockquote>{{ preview.excerpt }}</blockquote>
      </template>
      <p v-else-if="previewError" role="alert">{{ previewError }}</p>
    </aside>
  </section>
</template>

<script setup lang="ts">
import type {
  ChatBlock,
  KnowledgeCitationPreview,
  KnowledgeCitationReference,
} from '@autoforge/shared'
import { computed, nextTick, ref, watch } from 'vue'
import { displayError, getDesktopApi } from '../../services/desktop-api'

type KnowledgeAnswerBlock = Extract<ChatBlock, { type: 'knowledge_answer' }>
const props = withDefaults(defineProps<{
  block: KnowledgeAnswerBlock
  conversationId?: string
  messageId?: string
}>(), { conversationId: '', messageId: '' })

const sources = computed(() => props.block.claims.flatMap(({ citations }) => citations)
  .filter((citation, index, all) => (
    all.findIndex(candidate => citationKey(candidate) === citationKey(citation)) === index
  )))
const previewDialog = ref<globalThis.HTMLElement>()
const previewOpen = ref(false)
const previewLoading = ref(false)
const preview = ref<KnowledgeCitationPreview>()
const previewError = ref('')
const activeCitationIndex = ref(0)
let previewGeneration = 0
let previewReturnFocus: globalThis.HTMLElement | undefined

function citationKey(citation: KnowledgeCitationReference): string {
  return JSON.stringify(citation)
}

function citationIndex(citation: KnowledgeCitationReference): number {
  const key = citationKey(citation)
  return sources.value.findIndex(source => citationKey(source) === key)
}

function coordinateLabel(citation: KnowledgeCitationReference): string {
  if (citation.kind === 'pdf') return `PDF 第 ${citation.page} 页`
  if (citation.kind === 'docx') {
    const heading = citation.headingPath.length ? citation.headingPath.join(' › ') : '正文'
    return `DOCX ${heading} · 段落 ${citation.paragraphId}`
  }
  if (citation.kind === 'markdown') return `Markdown 节点 ${citation.nodeId}`
  if (citation.kind === 'html') return `HTML 节点 ${citation.nodeId}`
  if (citation.kind === 'txt') return `TXT 第 ${citation.startLine}-${citation.endLine} 行`
  return '来源位置'
}

const previewCoordinateLabel = computed(() => {
  const value = preview.value
  if (!value || value.status !== 'available') return ''
  if (value.kind === 'pdf') return `PDF 第 ${value.page} 页 · 文本项 ${value.itemStart}-${value.itemEnd}`
  if (value.kind === 'docx') {
    const heading = value.headingPath.length ? value.headingPath.join(' › ') : '正文'
    return `DOCX ${heading} · 段落 ${value.paragraphId}`
  }
  if (value.kind === 'markdown') return `Markdown 节点 ${value.nodeId}`
  if (value.kind === 'html') return `HTML 节点 ${value.nodeId}`
  if (value.kind === 'txt') {
    return `TXT 第 ${value.startLine}-${value.endLine} 行 · 字符 ${value.startColumn}-${value.endColumn}`
  }
  return ''
})

async function openPreview(citationIndexValue: number) {
  if (citationIndexValue < 0 || !props.conversationId || !props.messageId) return
  const generation = ++previewGeneration
  previewReturnFocus = globalThis.document.activeElement instanceof globalThis.HTMLElement
    ? globalThis.document.activeElement
    : undefined
  activeCitationIndex.value = citationIndexValue
  previewOpen.value = true
  previewLoading.value = true
  preview.value = undefined
  previewError.value = ''
  await nextTick()
  if (generation === previewGeneration) previewDialog.value?.focus()
  try {
    const result = await getDesktopApi().knowledge.previewCitation({
      conversationId: props.conversationId,
      messageId: props.messageId,
      blockId: props.block.blockId,
      citationIndex: citationIndexValue,
    })
    if (generation === previewGeneration) preview.value = result
  } catch (cause) {
    if (generation === previewGeneration) {
      previewError.value = displayError(cause, '来源预览加载失败')
    }
  } finally {
    if (generation === previewGeneration) previewLoading.value = false
  }
}

function closePreview() {
  const returnFocus = previewReturnFocus
  previewReturnFocus = undefined
  previewGeneration += 1
  previewOpen.value = false
  previewLoading.value = false
  if (returnFocus?.isConnected) void nextTick().then(() => { returnFocus.focus() })
}

watch(() => [props.conversationId, props.messageId, props.block.blockId], closePreview)
</script>

<style scoped>
.knowledge-answer { display: grid; gap: 12px; line-height: 1.65; }
.knowledge-claims { display: grid; gap: 10px; margin: 0; padding-left: 22px; }
.knowledge-claims li { padding-left: 2px; }
.citation-link, .source-link { border: 0; padding: 0; color: var(--af-cobalt); background: transparent; cursor: pointer; font: inherit; }
.citation-link { margin-left: 4px; font-size: .86em; vertical-align: super; }
.general-label { display: inline-flex; margin-left: 7px; border-radius: 999px; padding: 1px 7px; color: var(--af-text-muted); background: var(--af-surface-muted); font-size: 10px; }
.knowledge-sources { border-top: 1px solid var(--af-border); padding-top: 8px; color: var(--af-text-muted); font-size: 11px; }
.knowledge-sources summary { cursor: pointer; font-weight: 650; }
.knowledge-sources ol { display: grid; gap: 4px; margin: 7px 0 0; padding-left: 20px; }
.source-link { color: var(--af-text-muted); text-align: left; }
.citation-preview { display: grid; gap: 8px; border: 1px solid var(--af-border-strong); border-radius: 8px; padding: 12px; background: var(--af-surface-muted); }
.citation-preview header { display: flex; align-items: center; justify-content: space-between; }
.citation-preview header button { border: 0; color: var(--af-text-muted); background: transparent; cursor: pointer; }
.citation-preview p, .citation-preview blockquote { margin: 0; }
.citation-preview blockquote { border-left: 3px solid var(--af-cobalt); padding-left: 10px; color: var(--af-text); }
.preview-coordinate { color: var(--af-text-muted); font-size: 11px; }
</style>
