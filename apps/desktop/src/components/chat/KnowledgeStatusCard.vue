<template>
  <section
    :class="['knowledge-status', 'af-operation-card', `tone-${statusTone}`]"
    data-testid="knowledge-status"
    aria-live="polite"
  >
    <header class="af-operation-card-header">
      <span :class="['af-operation-marker', `tone-${statusTone}`]" aria-hidden="true">
        <el-icon :class="{ 'is-loading': block.state === 'searching' }">
          <component :is="statusIcon" />
        </el-icon>
      </span>
      <div class="af-operation-title">
        <span class="af-operation-eyebrow">知识库 · 第 {{ block.searchIndex }} 次检索 · 上限 {{ block.searchLimit }} 次</span>
        <strong>{{ resultSummary }}</strong>
      </div>
      <span class="af-operation-badge" data-testid="knowledge-status-badge">{{ statusLabel }}</span>
    </header>
    <div v-if="block.state === 'awaiting_consent'" class="af-operation-content knowledge-consent">
      <p class="af-operation-note">
        是否允许把本次检索片段发送给 {{ providerLabel }} 进行回答综合？授权只适用于该聊天供应商。
      </p>
      <div class="af-operation-footer">
        <el-button
          size="small"
          data-testid="deny-knowledge-consent"
          :disabled="submitting"
          @click="decide('deny')"
        >不允许</el-button>
        <el-button
          size="small"
          type="primary"
          data-testid="grant-knowledge-consent"
          :disabled="submitting"
          @click="decide('grant')"
        >允许并继续</el-button>
      </div>
      <p v-if="error" class="af-operation-alert status-error" role="alert">{{ error }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Check, CloseBold, Collection, Loading, Remove, Warning } from '@element-plus/icons-vue'
import type { ChatBlock } from '@autoforge/shared'
import { computed, ref, watch } from 'vue'
import { displayError, getDesktopApi } from '../../services/desktop-api'

type KnowledgeStatusBlock = Extract<ChatBlock, { type: 'knowledge_status' }>
const props = defineProps<{ block: KnowledgeStatusBlock }>()
const submitting = ref(false)
const error = ref('')

const statusLabel = computed(() => ({
  searching: '检索中', completed: '已完成', no_results: '未找到',
  awaiting_consent: '等待授权', consent_denied: '未授权',
  failed: '未完成', cancelled: '已取消',
})[props.block.state])
const statusTone = computed(() => ({
  searching: 'active', completed: 'success', no_results: 'neutral',
  awaiting_consent: 'warning', consent_denied: 'neutral',
  failed: 'danger', cancelled: 'neutral',
})[props.block.state])
const statusIcon = computed(() => ({
  searching: Loading, completed: Check, no_results: Collection,
  awaiting_consent: Warning, consent_denied: Remove,
  failed: CloseBold, cancelled: Remove,
})[props.block.state])
const resultSummary = computed(() => props.block.resultCount > 0
  ? `已找到 ${props.block.resultCount} 条证据`
  : props.block.state === 'searching' ? '正在检索所选知识库' : '没有找到相关证据')
const providerLabel = computed(() => props.block.provider === 'openrouter' ? 'OpenRouter' : 'DeepSeek')

watch(() => [props.block.requestId, props.block.state], () => {
  submitting.value = false
  error.value = ''
})

async function decide(decision: 'grant' | 'deny') {
  if (submitting.value) return
  submitting.value = true
  error.value = ''
  try {
    await getDesktopApi().chat.decideKnowledgeConsent({ requestId: props.block.requestId, decision })
  } catch (cause) {
    submitting.value = false
    error.value = displayError(cause, '知识片段授权提交失败，请重试')
  }
}
</script>

<style scoped>
.knowledge-consent { display: grid; gap: 10px; }
.knowledge-consent .af-operation-note { margin: 0; }
.knowledge-consent .af-operation-footer { justify-content: flex-end; }
.status-error { color: var(--af-danger); }
</style>
