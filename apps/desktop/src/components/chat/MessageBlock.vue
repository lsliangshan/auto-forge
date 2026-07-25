<template>
  <div class="message-block">
    <p
      v-if="block.type === 'text'"
      class="message-text"
    >
      {{ block.text }}
    </p>
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
import type { UiChatBlock } from '../../stores/chat'
import ApprovalCard from './ApprovalCard.vue'
import ExecutionCard from './ExecutionCard.vue'
import MediaBlock from './MediaBlock.vue'
import MediaGenerationBlock from './MediaGenerationBlock.vue'

defineProps<{ block: UiChatBlock }>()
</script>

<style scoped>
.message-block + .message-block { margin-top: 8px; }
.message-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.65; }
.reasoning { display: flex; align-items: center; gap: 7px; color: var(--af-text-muted); font-size: 12px; }
.proposal, .result { display: grid; gap: 5px; max-width: 640px; border: 1px solid var(--af-border); padding: 12px 14px; background: var(--af-surface-muted); }
.proposal strong { color: var(--af-cobalt); }.result p, .af-error p { margin: 4px 0 0; }
</style>
