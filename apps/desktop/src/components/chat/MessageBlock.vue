<template>
  <div class="message-block">
    <!-- eslint-disable vue/no-v-html -->
    <div
      v-if="block.type === 'text'"
      class="message-markdown"
      v-html="renderMarkdown(block.text)"
    />
    <!-- eslint-enable vue/no-v-html -->
    <div
      v-else-if="block.type === 'reasoning_status'"
      class="reasoning"
    >
      <el-icon class="is-loading">
        <Loading />
      </el-icon>{{ block.label }}
    </div>
    <section
      v-else-if="block.type === 'workflow_proposal'"
      class="proposal"
    >
      <span class="af-panel-heading">建议工作流</span><strong>{{ block.workflowName }}</strong>
    </section>
    <ApprovalCard
      v-else-if="block.type === 'approval'"
      :approval="block"
    />
    <WorkflowStatusCard
      v-else-if="block.type === 'workflow_status'"
      :block="block"
    />
    <WorkflowProvenance
      v-else-if="block.type === 'workflow_provenance'"
      :block="block"
    />
    <ExecutionCard
      v-else-if="block.type === 'workflow_execution'"
      :execution-id="block.executionId"
    />
    <section
      v-else-if="block.type === 'execution_result'"
      class="result"
    >
      <strong>执行结果</strong><p>{{ block.summary }}</p>
    </section>
    <section
      v-else-if="block.type === 'error'"
      class="af-error"
      role="alert"
    >
      <strong>处理失败</strong><p>{{ block.message }}</p>
    </section>
    <MediaBlock
      v-else-if="block.type === 'media'"
      :block="block"
    />
    <MediaGenerationBlock
      v-else-if="block.type === 'media_generation'"
      :block="block"
    />
  </div>
</template>

<script setup lang="ts">
import { Loading } from '@element-plus/icons-vue'
import 'highlight.js/styles/github-dark.css'
import type { UiChatBlock } from '../../stores/chat'
import ApprovalCard from './ApprovalCard.vue'
import ExecutionCard from './ExecutionCard.vue'
import { renderMarkdown } from './markdown'
import MediaBlock from './MediaBlock.vue'
import MediaGenerationBlock from './MediaGenerationBlock.vue'
import WorkflowProvenance from './WorkflowProvenance.vue'
import WorkflowStatusCard from './WorkflowStatusCard.vue'

defineProps<{ block: UiChatBlock }>()
</script>

<style scoped>
.message-block + .message-block { margin-top: 8px; }
.message-markdown { min-width: 0; overflow-wrap: anywhere; line-height: 1.65; }
.message-markdown > :deep(:first-child) { margin-top: 0; }
.message-markdown > :deep(:last-child) { margin-bottom: 0; }
.message-markdown :deep(p) { margin: 0 0 10px; }
.message-markdown :deep(h1),
.message-markdown :deep(h2),
.message-markdown :deep(h3),
.message-markdown :deep(h4) { margin: 18px 0 8px; line-height: 1.3; }
.message-markdown :deep(h1) { font-size: 1.5em; }
.message-markdown :deep(h2) { font-size: 1.3em; }
.message-markdown :deep(h3) { font-size: 1.15em; }
.message-markdown :deep(ul),
.message-markdown :deep(ol) { margin: 8px 0; padding-left: 24px; }
.message-markdown :deep(blockquote) { margin: 10px 0; border-left: 3px solid var(--af-border-strong); padding-left: 12px; color: var(--af-text-muted); }
.message-markdown :deep(a) { color: var(--af-cobalt); }
.message-markdown :deep(code) { border-radius: 4px; padding: 2px 5px; background: var(--af-surface-muted); font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: .92em; }
.message-markdown :deep(pre) { max-width: 100%; margin: 10px 0; overflow-x: auto; border-radius: 8px; padding: 14px 16px; color: #e6edf3; background: #0d1117; }
.message-markdown :deep(pre code) { display: block; overflow-wrap: normal; border-radius: 0; padding: 0; color: inherit; background: transparent; font-size: 12px; line-height: 1.6; white-space: pre; word-break: normal; }
.message-markdown :deep(table) { display: block; max-width: 100%; margin: 10px 0; overflow-x: auto; border-collapse: collapse; }
.message-markdown :deep(th),
.message-markdown :deep(td) { border: 1px solid var(--af-border); padding: 6px 10px; text-align: left; }
.message-markdown :deep(th) { background: var(--af-surface-muted); }
.reasoning { display: flex; align-items: center; gap: 7px; color: var(--af-text-muted); font-size: 12px; }
.proposal, .result { display: grid; gap: 5px; max-width: 640px; border: 1px solid var(--af-border); padding: 12px 14px; background: var(--af-surface-muted); }
.proposal strong { color: var(--af-cobalt); }.result p, .af-error p { margin: 4px 0 0; }
</style>
