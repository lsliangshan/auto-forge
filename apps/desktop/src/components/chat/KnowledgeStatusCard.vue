<template>
  <section
    :class="['knowledge-status', 'af-operation-card', `tone-${statusTone}`]"
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
        <strong>{{ displayStatusLabel }}</strong>
      </div>
      <div class="af-operation-summary">
        <span
          class="af-operation-badge"
          data-testid="knowledge-consent-badge"
        >{{ statusBadgeLabel }}</span>
      </div>
    </header>
    <div
      v-if="canDecide || decisionMessage || consentError"
      class="af-operation-content knowledge-status-content"
    >
      <div
        v-if="canDecide"
        class="knowledge-consent-panel"
        data-testid="knowledge-consent-panel"
      >
        <div class="knowledge-consent-heading">
          <span
            class="knowledge-consent-icon"
            aria-hidden="true"
          ><el-icon><Lock /></el-icon></span>
          <div>
            <span>授权对象</span>
            <strong data-testid="knowledge-consent-provider">{{ providerLabel }}</strong>
          </div>
        </div>
        <p>{{ consentDescription }}</p>
        <footer class="af-operation-footer knowledge-consent-actions">
          <template v-if="consentStatus === 'unknown'">
            <el-button
              size="small"
              data-testid="deny-knowledge-consent"
              :disabled="busy"
              @click="setConsent('denied')"
            >
              拒绝
            </el-button>
            <el-button
              size="small"
              type="primary"
              data-testid="grant-knowledge-consent"
              :disabled="busy"
              @click="setConsent('granted')"
            >
              允许发送依据
            </el-button>
          </template>
          <el-button
            v-else
            size="small"
            plain
            data-testid="revoke-knowledge-consent"
            :disabled="busy"
            @click="revokeConsent"
          >
            {{ consentStatus === 'denied' ? '重置授权选择' : '撤销授权' }}
          </el-button>
        </footer>
      </div>
      <p
        v-if="decisionMessage"
        class="knowledge-consent-feedback"
        role="status"
      >
        <el-icon aria-hidden="true"><Check /></el-icon><span>{{ decisionMessage }}</span>
      </p>
      <p
        v-if="consentError"
        class="knowledge-consent-error"
        data-testid="knowledge-consent-error"
        role="alert"
        aria-live="polite"
      >
        <el-icon aria-hidden="true"><Warning /></el-icon><span>{{ consentError }}</span>
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Check, Lock, Reading, Warning } from '@element-plus/icons-vue'
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
const providerLabel = computed(() => props.block.provider === 'deepseek' ? 'DeepSeek' : 'OpenRouter')
const displayStatusLabel = computed(() => {
  if (!canDecide.value || consentStatus.value === 'unknown') return statusLabel.value
  return consentStatus.value === 'granted' ? '已允许发送知识库依据' : '知识库依据保持在本机'
})
const statusBadgeLabel = computed(() => {
  if (canDecide.value) {
    if (busy.value) return '处理中'
    return ({ unknown: '待授权', granted: '已授权', denied: '已拒绝' })[consentStatus.value]
  }
  return ({
    searching: '检索中',
    found: '已完成',
    consent_required: '待授权',
    consent_denied: '未发送',
    insufficient: '依据不足',
    source_unavailable: '来源不可用',
    failed: '未完成',
  })[props.block.status]
})
const statusTone = computed(() => {
  if (consentError.value) return 'danger'
  if (canDecide.value) return ({ unknown: 'warning', granted: 'success', denied: 'neutral' })[consentStatus.value]
  return ({
    searching: 'active',
    found: 'success',
    consent_required: 'warning',
    consent_denied: 'neutral',
    insufficient: 'warning',
    source_unavailable: 'warning',
    failed: 'danger',
  })[props.block.status]
})
const consentDescription = computed(() => {
  if (consentStatus.value === 'granted') return `已允许向 ${providerLabel.value} 发送知识库检索依据；授权会保留，可随时撤销。`
  if (consentStatus.value === 'denied') return `当前不会向 ${providerLabel.value} 发送知识库检索依据。`
  return `允许向 ${providerLabel.value} 发送知识库检索依据；授权会保留，可随时撤销。`
})
</script>

<style scoped>
.knowledge-status { max-width: 680px; }
.knowledge-status-content { padding-top: 1px; padding-bottom: 16px; }
.knowledge-consent-panel { border: 1px solid var(--af-border); border-radius: 11px; padding: 12px; background: transparent; }
.knowledge-consent-heading { display: flex; align-items: center; gap: 9px; }
.knowledge-consent-icon { display: grid; width: 28px; height: 28px; flex: 0 0 28px; place-items: center; border-radius: 8px; color: var(--operation-accent); background: var(--operation-soft); font-size: 13px; }
.knowledge-consent-heading div { display: grid; gap: 1px; }
.knowledge-consent-heading span:not(.knowledge-consent-icon) { color: var(--af-text-muted); font-size: 9px; font-weight: 700; letter-spacing: .06em; }
.knowledge-consent-heading strong { color: var(--af-graphite); font-size: 12px; font-weight: 680; }
.knowledge-consent-panel > p { margin: 9px 0 0; color: var(--af-text-muted); font-size: 11px; line-height: 1.55; }
.knowledge-consent-actions { margin-top: 12px; border-top: 1px solid var(--af-border); padding-top: 12px; }
.knowledge-consent-actions :deep(.el-button) { min-width: 72px; border-radius: 8px; font-weight: 650; }
.knowledge-consent-actions :deep(.el-button--primary) { min-width: 112px; box-shadow: 0 4px 10px color-mix(in srgb, var(--af-cobalt) 18%, transparent); }
.knowledge-consent-feedback,
.knowledge-consent-error { display: flex; align-items: flex-start; gap: 7px; margin: 11px 0 0; border-left: 2px solid currentcolor; padding: 2px 0 2px 9px; font-size: 11px; line-height: 1.5; }
.knowledge-consent-feedback { color: var(--af-success); }
.knowledge-consent-error { color: var(--af-danger); }
.knowledge-consent-feedback .el-icon,
.knowledge-consent-error .el-icon { flex: none; margin-top: 2px; }
</style>
