<template>
  <section
    :class="['approval-card', 'af-operation-card', `tone-${statusTone}`, { 'is-collapsed': !expanded }]"
    data-testid="approval-card"
    aria-live="polite"
  >
    <header class="af-operation-card-header">
      <span
        class="af-operation-marker"
        aria-hidden="true"
      >
        <el-icon><component :is="statusIcon" /></el-icon>
      </span>
      <div class="af-operation-title">
        <span class="af-operation-eyebrow">权限请求</span>
        <strong>{{ approval.workflowName }}</strong>
      </div>
      <div class="af-operation-summary">
        <span
          class="af-operation-badge"
          data-testid="approval-status-badge"
        >{{ approvalStateLabel }}</span>
        <button
          type="button"
          class="af-operation-toggle"
          data-testid="toggle-approval-details"
          :aria-expanded="expanded"
          :aria-controls="contentId"
          :aria-label="expanded ? '收起授权详情' : '展开授权详情'"
          @click="expanded = !expanded"
        >
          <el-icon><ArrowDown /></el-icon>
        </button>
      </div>
    </header>

    <div
      v-if="expanded"
      :id="contentId"
      class="af-operation-content approval-content"
      data-testid="approval-card-content"
    >
      <p class="af-operation-note approval-description">
        <span class="af-operation-note-dot" /><span>{{ capabilityLabel }}</span>
      </p>

      <dl class="approval-summary-list">
        <dt>操作</dt><dd>{{ approval.actionSummary }}</dd>
        <dt>能力</dt><dd><code>{{ approval.capability }}</code></dd>
        <dt>范围</dt><dd>{{ scopeLabel }}</dd>
      </dl>

      <details
        class="approval-technical-details"
        data-testid="approval-technical-details"
      >
        <summary>
          <span>查看技术详情</span>
          <el-icon aria-hidden="true">
            <ArrowDown />
          </el-icon>
        </summary>
        <dl class="approval-technical-list">
          <dt>标识</dt><dd>{{ approval.workflowId }}</dd>
          <dt>版本</dt><dd>{{ approval.workflowVersion }}</dd>
          <dt>来源</dt><dd>{{ sourceLabel }}</dd>
          <template v-if="approval.buildHash">
            <dt>构建</dt><dd>{{ approval.buildHash }}</dd>
          </template>
          <dt>城市</dt><dd>{{ approval.city ?? '不限城市' }}</dd>
        </dl>
      </details>

      <p
        v-if="error"
        class="approval-error"
        role="alert"
      >
        <el-icon aria-hidden="true">
          <Warning />
        </el-icon><span>{{ error }}</span>
      </p>

      <div
        v-if="approval.state === 'pending'"
        class="af-operation-footer approval-actions"
      >
        <el-button
          size="small"
          data-testid="deny-approval"
          :disabled="busy || submitted"
          @click="decide('deny')"
        >
          拒绝
        </el-button>
        <el-button
          size="small"
          type="primary"
          data-testid="approve-once"
          :disabled="busy || submitted"
          @click="decide('once')"
        >
          仅本次允许
        </el-button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ArrowDown, Check, CloseBold, Lock, Remove, Warning } from '@element-plus/icons-vue'
import type { ApprovalDecision, ChatBlock } from '@autoforge/shared'
import { computed, ref, watch } from 'vue'
import { displayError, getDesktopApi } from '../../services/desktop-api'

type ApprovalBlock = Extract<ChatBlock, { type: 'approval' }>
const props = defineProps<{ approval: ApprovalBlock }>()
const busy = ref(false)
const submitted = ref(false)
const error = ref('')
const expanded = ref(props.approval.state === 'pending')

const contentId = computed(() => `approval-content-${props.approval.blockId}`)
const capabilityLabel = computed(() => props.approval.capability.startsWith('browser.')
  ? '该工作流希望控制自动化浏览器，请确认本次操作与授权范围。'
  : '该工作流请求使用受控宿主能力，请确认本次操作与授权范围。')
const sourceLabel = computed(() => props.approval.source === 'development' ? '开发版本' : '已安装')
const approvalStateLabel = computed(() => ({
  pending: '待确认',
  approved: '已允许本次',
  denied: '已拒绝',
  expired: '审批已过期',
  cancelled: '审批已取消',
  invalidated: '审批已失效',
})[props.approval.state])
const statusTone = computed(() => ({
  pending: 'warning',
  approved: 'success',
  denied: 'danger',
  expired: 'neutral',
  cancelled: 'neutral',
  invalidated: 'neutral',
})[props.approval.state])
const statusIcon = computed(() => ({
  pending: Lock,
  approved: Check,
  denied: CloseBold,
  expired: Remove,
  cancelled: Remove,
  invalidated: Remove,
})[props.approval.state])
const scopeLabel = computed(() => {
  if ('origins' in props.approval.scope) return props.approval.scope.origins.join('、')
  if ('paths' in props.approval.scope) return props.approval.scope.paths.join('、')
  return '不包含附加范围'
})

watch(() => props.approval.state, (state) => {
  expanded.value = state === 'pending'
})

async function decide(decision: 'once' | 'deny') {
  if (busy.value || submitted.value || props.approval.state !== 'pending') return
  busy.value = true
  error.value = ''
  const base = {
    executionId: props.approval.executionId,
    permissionIndex: props.approval.permissionIndex,
    scopeHash: props.approval.scopeHash,
  }
  const input: ApprovalDecision = { ...base, decision }
  try {
    await getDesktopApi().executions.decide(input)
    submitted.value = true
  } catch (caught) { error.value = displayError(caught, '审批提交失败') }
  finally { busy.value = false }
}
</script>

<style scoped>
.approval-content { padding-bottom: 16px; }
.approval-description { margin-top: 0; }
.approval-summary-list,
.approval-technical-list { display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 7px 12px; margin: 13px 0 0; font-size: 11px; line-height: 1.5; }
.approval-summary-list dt,
.approval-technical-list dt { color: var(--af-text-muted); }
.approval-summary-list dd,
.approval-technical-list dd { min-width: 0; margin: 0; overflow-wrap: anywhere; color: var(--af-text); }
.approval-summary-list code { border-radius: 5px; padding: 2px 5px; color: var(--af-text); background: var(--af-surface-muted); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 10px; }
.approval-technical-details { margin-top: 12px; border-top: 1px solid var(--af-border); padding-top: 8px; color: var(--af-text-muted); }
.approval-technical-details summary { display: inline-flex; min-height: 32px; align-items: center; gap: 5px; border-radius: 7px; padding: 5px 7px; color: var(--af-cobalt); cursor: pointer; font-size: 11px; font-weight: 650; list-style: none; }
.approval-technical-details summary::-webkit-details-marker { display: none; }
.approval-technical-details summary:hover { background: var(--af-cobalt-soft); }
.approval-technical-details summary .el-icon { transition: transform .18s ease; }
.approval-technical-details[open] summary .el-icon { transform: rotate(180deg); }
.approval-technical-list { margin: 6px 7px 2px; border-left: 1px solid var(--af-border); padding-left: 12px; }
.approval-error { display: flex; align-items: flex-start; gap: 7px; margin: 10px 0 0; border-radius: 8px; padding: 8px 10px; color: var(--af-danger); background: var(--af-danger-soft); font-size: 11px; line-height: 1.5; }
.approval-error .el-icon { flex: none; margin-top: 2px; }
.approval-actions { border-top: 1px solid var(--af-border); padding-top: 12px; }
</style>
