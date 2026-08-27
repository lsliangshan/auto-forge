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
    <div
      v-if="canDecide"
      class="knowledge-consent-actions"
    >
      <button
        type="button"
        data-testid="grant-knowledge-consent"
        :disabled="busy"
        @click="setConsent('granted')"
      >
        允许发送依据
      </button>
      <button
        type="button"
        data-testid="deny-knowledge-consent"
        :disabled="busy"
        @click="setConsent('denied')"
      >
        拒绝
      </button>
      <button
        v-if="grantedHere"
        type="button"
        data-testid="revoke-knowledge-consent"
        :disabled="busy"
        @click="revokeConsent"
      >
        撤销授权
      </button>
    </div>
    <p v-if="decisionMessage">
      {{ decisionMessage }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { Reading } from '@element-plus/icons-vue'
import type { ChatBlock } from '@autoforge/shared'
import { computed } from 'vue'
import { ref } from 'vue'
import { getDesktopApi } from '../../services/desktop-api'

type KnowledgeStatusBlock = Extract<ChatBlock, { type: 'knowledge_status' }>
const props = defineProps<{ block: KnowledgeStatusBlock }>()
const busy = ref(false)
const decisionMessage = ref('')
const grantedHere = ref(false)
const canDecide = computed(() => (
  (props.block.status === 'consent_required' || props.block.status === 'consent_denied')
  && props.block.provider !== undefined
))
async function setConsent(status: 'granted' | 'denied') {
  if (!props.block.provider || busy.value) return
  busy.value = true
  try {
    await getDesktopApi().knowledge.setConsent(props.block.provider, status)
    grantedHere.value = status === 'granted'
    decisionMessage.value = status === 'granted' ? '已授权，请重新发送问题。' : '已拒绝发送知识库依据。'
  } finally {
    busy.value = false
  }
}
async function revokeConsent() {
  if (!props.block.provider || busy.value) return
  busy.value = true
  try {
    await getDesktopApi().knowledge.revokeConsent(props.block.provider)
    grantedHere.value = false
    decisionMessage.value = '已撤销当前模型供应商的知识库依据授权。'
  } finally {
    busy.value = false
  }
}
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
.knowledge-consent-actions { display: flex; gap: 8px; margin-top: 8px; }
</style>
