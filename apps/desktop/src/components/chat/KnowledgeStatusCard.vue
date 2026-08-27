<template>
  <section
    class="knowledge-status af-operation-card"
    data-testid="knowledge-status"
    aria-live="polite"
  >
    <header class="af-operation-card-header">
      <span
        class="af-operation-marker"
        aria-hidden="true"
      ><el-icon><Reading /></el-icon></span>
      <div class="af-operation-title">
        <span class="af-operation-eyebrow">个人知识库 · 第 {{ block.searchIndex }} 次检索 · 上限 {{ block.searchLimit }} 次</span>
        <strong>{{ statusLabel }}</strong>
      </div>
    </header>
  </section>
</template>

<script setup lang="ts">
import { Reading } from '@element-plus/icons-vue'
import type { ChatBlock } from '@autoforge/shared'
import { computed } from 'vue'

type KnowledgeStatusBlock = Extract<ChatBlock, { type: 'knowledge_status' }>
const props = defineProps<{ block: KnowledgeStatusBlock }>()
const statusLabel = computed(() => ({
  searching: '正在检索所选知识库',
  found: `已找到 ${props.block.evidenceCount} 条依据`,
  consent_required: '需要授权后才能发送依据',
  consent_denied: '依据仅保留在本机，未发送给模型',
  insufficient: '所选知识库中依据不足',
  source_unavailable: '引用来源当前不可用',
  failed: '知识库检索未完成',
})[props.block.status])
</script>

<style scoped>
.knowledge-status { max-width: 680px; }
</style>
