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
        v-if="consentStatus === 'unknown'"
        type="button"
        data-testid="grant-knowledge-consent"
        :disabled="busy"
        @click="setConsent('granted')"
      >
        允许发送依据
      </button>
      <button
        v-if="consentStatus === 'unknown'"
        type="button"
        data-testid="deny-knowledge-consent"
        :disabled="busy"
        @click="setConsent('denied')"
      >
        拒绝
      </button>
      <button
        v-if="consentStatus === 'granted' || consentStatus === 'denied'"
        type="button"
        data-testid="revoke-knowledge-consent"
        :disabled="busy"
        @click="revokeConsent"
      >
        {{ consentStatus === 'denied' ? '重置授权选择' : '撤销授权' }}
      </button>
    </div>
    <p v-if="decisionMessage">
      {{ decisionMessage }}
    </p>
    <p
      v-if="consentError"
      data-testid="knowledge-consent-error"
      aria-live="polite"
    >
      {{ consentError }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { Reading } from '@element-plus/icons-vue'
import type { ChatBlock } from '@autoforge/shared'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { displayError, getDesktopApi } from '../../services/desktop-api'

type KnowledgeStatusBlock = Extract<ChatBlock, { type: 'knowledge_status' }>
const props = defineProps<{ block: KnowledgeStatusBlock }>()
const busy = ref(false)
const decisionMessage = ref('')
const consentError = ref('')
const consentStatus = ref<'unknown' | 'granted' | 'denied'>('unknown')
let operationEpoch = 0
interface ConsentOperation { epoch: number; provider: NonNullable<KnowledgeStatusBlock['provider']> }
function beginOperation(provider: NonNullable<KnowledgeStatusBlock['provider']>): ConsentOperation {
  return { epoch: ++operationEpoch, provider }
}
function isCurrent(operation: ConsentOperation): boolean {
  return operation.epoch === operationEpoch && props.block.provider === operation.provider
}
const canDecide = computed(() => (
  (props.block.status === 'consent_required' || props.block.status === 'consent_denied')
  && props.block.provider !== undefined
))
watch(() => props.block.provider, async (provider) => {
  operationEpoch += 1
  busy.value = false
  consentStatus.value = 'unknown'
  decisionMessage.value = ''
  consentError.value = ''
  if (!provider) return
  const operation = beginOperation(provider)
  try {
    const state = await getDesktopApi().knowledge.getConsent(provider)
    if (!isCurrent(operation)) return
    consentStatus.value = state.status
    if (state.status === 'granted') decisionMessage.value = '已授权当前模型供应商。'
    if (state.status === 'denied') decisionMessage.value = '已拒绝向当前模型供应商发送依据。'
  } catch (error) {
    if (isCurrent(operation)) consentError.value = displayError(error, '无法读取当前授权状态。')
  }
}, { immediate: true })
async function setConsent(status: 'granted' | 'denied') {
  const provider = props.block.provider
  if (!provider || busy.value) return
  const operation = beginOperation(provider)
  busy.value = true
  consentError.value = ''
  try {
    await getDesktopApi().knowledge.setConsent(provider, status)
    if (!isCurrent(operation)) return
    consentStatus.value = status
    decisionMessage.value = status === 'granted' ? '已授权，请重新发送问题。' : '已拒绝发送知识库依据。'
  } catch (error) {
    if (isCurrent(operation)) consentError.value = displayError(error, '无法更新当前授权状态。')
  } finally {
    if (isCurrent(operation)) busy.value = false
  }
}
async function revokeConsent() {
  const provider = props.block.provider
  if (!provider || busy.value) return
  const operation = beginOperation(provider)
  busy.value = true
  consentError.value = ''
  try {
    await getDesktopApi().knowledge.revokeConsent(provider)
    if (!isCurrent(operation)) return
    consentStatus.value = 'unknown'
    decisionMessage.value = '已撤销当前模型供应商的知识库依据授权。'
  } catch (error) {
    if (isCurrent(operation)) consentError.value = displayError(error, '无法重置当前授权状态。')
  } finally {
    if (isCurrent(operation)) busy.value = false
  }
}
onBeforeUnmount(() => { operationEpoch += 1 })
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
