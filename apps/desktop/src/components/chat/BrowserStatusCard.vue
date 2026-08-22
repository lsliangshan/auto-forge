<template>
  <section
    class="browser-status"
    data-testid="browser-status"
    aria-live="polite"
  >
    <div class="status-heading">
      <span :class="['af-status-dot', statusTone]" />
      <strong>{{ statusLabel }}</strong>
    </div>
    <div class="site-meta">
      <span>{{ block.siteLabel }}</span>
      <span>{{ block.origin }}</span>
    </div>
    <p
      v-if="block.actionSummary"
      data-testid="browser-action-summary"
      class="action-summary"
    >
      {{ block.actionSummary }}
    </p>
    <p
      v-if="statusError"
      class="status-error"
      role="alert"
    >
      {{ statusError }}
    </p>
    <div class="status-actions">
      <el-button
        size="small"
        data-testid="stop-browser"
        :disabled="actionsDisabled"
        @click="runAction('stop')"
      >
        停止
      </el-button>
      <el-button
        size="small"
        type="primary"
        plain
        data-testid="take-over-browser"
        :disabled="actionsDisabled"
        @click="runAction('takeover')"
      >
        接管
      </el-button>
    </div>
    <details
      data-testid="browser-audit"
      class="browser-audit"
      @toggle="loadAudit"
    >
      <summary>查看操作记录</summary>
      <p v-if="auditLoading">
        正在加载操作记录…
      </p>
      <p
        v-else-if="auditError"
        class="status-error"
        role="alert"
      >
        {{ auditError }}
      </p>
      <p v-else-if="auditLoaded && !auditEntries.length">
        暂无操作记录。
      </p>
      <ol v-else-if="auditEntries.length">
        <li
          v-for="entry in auditEntries"
          :key="entry.id"
          data-testid="browser-audit-entry"
        >
          <strong>{{ entry.action }}</strong>
          <span>{{ entry.origin }}</span>
          <span>{{ outcomeLabel(entry.outcome) }}</span>
          <span v-if="entry.errorCode">{{ displayError({ code: entry.errorCode }) }}</span>
        </li>
      </ol>
    </details>
  </section>
</template>

<script setup lang="ts">
import type { BrowserActionAuditEntry, ChatBlock } from '@autoforge/shared'
import { computed, ref, watch } from 'vue'
import { displayError, getDesktopApi } from '../../services/desktop-api'

type BrowserStatusBlock = Extract<ChatBlock, { type: 'browser_status' }>
const props = defineProps<{ block: BrowserStatusBlock }>()
const actionBusy = ref(false)
const actionSettled = ref(false)
const actionError = ref('')
const auditEntries = ref<BrowserActionAuditEntry[]>([])
const auditLoading = ref(false)
const auditLoaded = ref(false)
const auditError = ref('')
let identityGeneration = 0

interface AsyncIdentity {
  generation: number
  requestId: string
  bindingId: string
}

const statusLabel = computed(() => ({
  inspecting: 'AI 正在读取网页',
  acting: 'AI 正在操作',
  awaiting_user: '需要你在浏览器中操作',
  completed: '浏览器自动操作已完成',
  failed: '浏览器自动操作失败',
  cancelled: '浏览器自动操作已停止',
})[props.block.state])
const statusTone = computed(() => props.block.state === 'completed'
  ? 'success'
  : ['failed', 'cancelled'].includes(props.block.state) ? 'danger' : 'warning')
const terminal = computed(() => ['completed', 'failed', 'cancelled'].includes(props.block.state))
const actionsDisabled = computed(() => terminal.value || actionBusy.value || actionSettled.value)
const statusError = computed(() => actionError.value
  || (props.block.errorCode ? displayError({ code: props.block.errorCode }) : ''))

watch(() => [props.block.requestId, props.block.bindingId], () => {
  identityGeneration += 1
  actionBusy.value = false
  actionSettled.value = false
  actionError.value = ''
  auditEntries.value = []
  auditLoading.value = false
  auditLoaded.value = false
  auditError.value = ''
}, { flush: 'sync' })

function captureIdentity(): AsyncIdentity {
  return {
    generation: identityGeneration,
    requestId: props.block.requestId,
    bindingId: props.block.bindingId,
  }
}

function isCurrent(identity: AsyncIdentity): boolean {
  return identity.generation === identityGeneration
    && identity.requestId === props.block.requestId
    && identity.bindingId === props.block.bindingId
}

async function runAction(action: 'stop' | 'takeover') {
  if (actionsDisabled.value) return
  const identity = captureIdentity()
  actionBusy.value = true
  actionError.value = ''
  try {
    if (action === 'stop') await getDesktopApi().chat.cancel(identity.requestId)
    else await getDesktopApi().chat.takeOverBrowser({
      requestId: identity.requestId,
      bindingId: identity.bindingId,
    })
    if (!isCurrent(identity)) return
    actionSettled.value = true
  } catch (error) {
    if (!isCurrent(identity)) return
    actionError.value = displayError(error, action === 'stop' ? '停止失败' : '接管失败')
  } finally {
    if (isCurrent(identity)) actionBusy.value = false
  }
}

async function loadAudit(event: { currentTarget: unknown }) {
  const details = event.currentTarget
  if (!details || typeof details !== 'object' || !('open' in details) || details.open !== true
    || auditLoaded.value || auditLoading.value) return
  const identity = captureIdentity()
  auditLoading.value = true
  auditError.value = ''
  try {
    const entries = await getDesktopApi().chat.listBrowserAudit(identity.bindingId)
    if (!isCurrent(identity)) return
    auditEntries.value = [...entries].sort((left, right) => left.sequence - right.sequence)
    if (!isCurrent(identity)) return
    auditLoaded.value = true
  } catch (error) {
    if (!isCurrent(identity)) return
    auditError.value = displayError(error, '操作记录加载失败')
  } finally {
    if (isCurrent(identity)) auditLoading.value = false
  }
}

function outcomeLabel(outcome: BrowserActionAuditEntry['outcome']): string {
  return ({
    completed: '已完成',
    blocked: '已阻止',
    failed: '失败',
    cancelled: '已取消',
    handed_off: '已交由你操作',
  })[outcome]
}
</script>

<style scoped>
.browser-status { max-width: 640px; border: 1px solid var(--af-border); border-left: 3px solid var(--af-cobalt); padding: 13px 14px; background: var(--af-surface-muted); }
.status-heading, .site-meta, .status-actions { display: flex; align-items: center; }
.status-heading { gap: 8px; }
.site-meta { flex-wrap: wrap; gap: 6px 12px; margin-top: 8px; color: var(--af-text-muted); font-size: 11px; overflow-wrap: anywhere; }
.site-meta span + span::before { margin-right: 12px; content: '·'; }
.action-summary, .status-error, .browser-audit p { margin: 8px 0 0; font-size: 12px; overflow-wrap: anywhere; }
.action-summary, .browser-audit p { color: var(--af-text-muted); }
.status-error { color: var(--af-danger); }
.status-actions { justify-content: flex-end; margin-top: 10px; }
.browser-audit { margin-top: 10px; border-top: 1px solid var(--af-border); padding-top: 9px; font-size: 12px; }
.browser-audit summary { width: fit-content; cursor: pointer; color: var(--af-cobalt); }
.browser-audit ol { display: grid; gap: 8px; margin: 9px 0 0; padding-left: 20px; }
.browser-audit li { overflow-wrap: anywhere; }
.browser-audit li span { display: block; margin-top: 2px; color: var(--af-text-muted); }
</style>
