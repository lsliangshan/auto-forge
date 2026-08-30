<template>
  <section
    :class="['browser-status', 'af-operation-card', `tone-${statusTone}`, { 'is-collapsed': !expanded }]"
    data-testid="browser-status"
    aria-live="polite"
  >
    <header class="af-operation-card-header">
      <span
        :class="['af-operation-marker', `tone-${statusTone}`, { 'is-loading': block.state === 'inspecting' }]"
        data-testid="browser-status-icon"
        aria-hidden="true"
      >
        <el-icon><component :is="statusIcon" /></el-icon>
      </span>
      <div class="af-operation-title">
        <span class="af-operation-eyebrow">浏览器自动化</span>
        <strong>{{ block.siteLabel }}</strong>
      </div>
      <div class="af-operation-summary">
        <span
          class="af-operation-badge"
          data-testid="browser-status-badge"
        >{{ statusLabel }}</span>
        <button
          type="button"
          class="af-operation-toggle"
          data-testid="toggle-browser-details"
          :aria-expanded="expanded"
          :aria-controls="contentId"
          :aria-label="expanded ? '收起浏览器操作详情' : '展开浏览器操作详情'"
          @click="expanded = !expanded"
        >
          <el-icon><ArrowDown /></el-icon>
        </button>
      </div>
    </header>
    <div
      v-if="expanded"
      :id="contentId"
      class="af-operation-content"
      data-testid="browser-status-content"
    >
      <div class="af-operation-meta">
        <span class="af-operation-chip">{{ block.origin }}</span>
      </div>
      <p
        v-if="block.actionSummary && !statusError"
        data-testid="browser-action-summary"
        class="af-operation-note"
      >
        <span class="af-operation-note-dot" /><span>{{ block.actionSummary }}</span>
      </p>
      <p
        v-if="statusError"
        class="af-operation-alert status-error"
        role="alert"
      >
        <el-icon aria-hidden="true">
          <Warning />
        </el-icon><span>{{ statusError }}</span>
      </p>
      <div
        v-if="!terminal"
        class="af-operation-footer status-actions"
      >
        <el-button
          size="small"
          data-testid="stop-browser"
          :disabled="actionsDisabled"
          @click="runAction('stop')"
        >
          停止
        </el-button>
        <el-button
          v-if="!awaitingUser"
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
    </div>
  </section>
</template>

<script setup lang="ts">
import { ArrowDown, Check, CloseBold, Loading, Monitor, Remove, UserFilled, Warning } from '@element-plus/icons-vue'
import type { BrowserActionAuditEntry, ChatBlock } from '@autoforge/shared'
import { computed, ref, watch } from 'vue'
import { displayError, getDesktopApi } from '../../services/desktop-api'

type BrowserStatusBlock = Extract<ChatBlock, { type: 'browser_status' }>
const props = defineProps<{ block: BrowserStatusBlock }>()
const contentId = computed(() => `browser-status-content-${props.block.blockId}`)
const actionBusy = ref(false)
const actionSettled = ref(false)
const actionError = ref('')
const expanded = ref(props.block.state !== 'completed')
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

const awaitingLogin = computed(() => props.block.state === 'awaiting_user'
  && props.block.errorCode === 'AUTH_REQUIRED')
const manualCodes = [
  'MANUAL_ACTION_REQUIRED',
  'UNSUPPORTED_CONTROL',
  'MANUAL_INTERVENTION_REQUIRED',
] as const
const awaitingManual = computed(() => props.block.state === 'awaiting_user'
  && manualCodes.some((code) => code === props.block.errorCode))
const awaitingUser = computed(() => awaitingLogin.value || awaitingManual.value)
const statusLabel = computed(() => awaitingLogin.value
  ? '等待你登录'
  : awaitingManual.value ? '等待你手动操作' : ({
  inspecting: '读取中',
  acting: '操作中',
  awaiting_user: '需要你在浏览器中操作',
  completed: '已完成',
  failed: '未完成',
  cancelled: '已取消',
})[props.block.state])
const statusTone = computed(() => ({
  inspecting: 'active',
  acting: 'active',
  awaiting_user: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
})[props.block.state])
const statusIcon = computed(() => awaitingUser.value ? UserFilled : ({
  inspecting: Loading,
  acting: Monitor,
  awaiting_user: Warning,
  completed: Check,
  failed: CloseBold,
  cancelled: Remove,
})[props.block.state])
const terminal = computed(() => !awaitingUser.value
  && ['awaiting_user', 'completed', 'failed', 'cancelled'].includes(props.block.state))
const actionsDisabled = computed(() => terminal.value || actionBusy.value || actionSettled.value)
const statusError = computed(() => {
  if (actionError.value) return actionError.value
  if (props.block.state === 'cancelled' || awaitingUser.value || !props.block.errorCode) return ''
  return displayError({ code: props.block.errorCode })
})

watch(() => props.block.state, (state) => {
  expanded.value = state !== 'completed'
})

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
.status-error { color: var(--af-danger); }
.browser-audit { margin-top: 10px; border-top: 1px solid var(--af-border); padding-top: 9px; font-size: 0.75rem; }
.browser-audit summary { width: fit-content; cursor: pointer; color: var(--af-cobalt); }
.browser-audit p { margin: 8px 0 0; color: var(--af-text-muted); font-size: 0.75rem; overflow-wrap: anywhere; }
.browser-audit ol { display: grid; gap: 8px; margin: 9px 0 0; padding-left: 20px; }
.browser-audit li { overflow-wrap: anywhere; }
.browser-audit li span { display: block; margin-top: 2px; color: var(--af-text-muted); }
</style>
